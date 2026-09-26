// Deliberately no package loader, shell tool, path parameter or mutable command map.
// The separately approved installer seals this executable, its embedded observer,
// target binding and installation admission under administrator-owned ACLs.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Fai.M1 {
    internal sealed class Denied : Exception {
        internal Denied(string code) : base(code) { }
    }

    internal static class Data {
        internal const string Candidate = "fb645e014653ee87dc64f2439970967192f91b62";
        internal const string Namespace = "FAI-CRM-M1-R18";
        internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 262144, RecursionLimit = 40 };
        internal static void Need(bool value, string code) { if (!value) throw new Denied(code); }
        internal static string Encode(object value) { return Json.Serialize(value); }
        internal static string Sha(byte[] value) { using(var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(value)).Replace("-", "").ToLowerInvariant(); }
        internal static string FileSha(string path) { using(var f = File.OpenRead(path)) using(var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(f)).Replace("-", "").ToLowerInvariant(); }
        internal static string Text(object value) { Need(value is string, "STRING_REQUIRED"); return (string)value; }
        internal static Dictionary<string,object> Obj(object value) { var d=value as Dictionary<string,object>; Need(d!=null,"OBJECT_REQUIRED"); return d; }
        internal static void Fields(Dictionary<string,object> d, params string[] keys) { Need(d.Count==keys.Length && keys.All(d.ContainsKey),"UNEXPECTED_FIELDS"); }
        internal static byte[] Resource(string name) {
            using(var s=Assembly.GetExecutingAssembly().GetManifestResourceStream(name)) {
                Need(s!=null,"SEALED_RESOURCE_MISSING"); using(var m=new MemoryStream()) { s.CopyTo(m); return m.ToArray(); }
            }
        }
    }

    // Strict JSON parsing also rejects duplicate keys and non-finite numbers.
    internal sealed class StrictJson {
        readonly string input; int at;
        StrictJson(string text) { input=text; }
        internal static object Parse(string text) { Data.Need(text.Length<=131072,"JSON_LIMIT"); var p=new StrictJson(text); var v=p.Value(0); p.Space(); Data.Need(p.at==text.Length,"INVALID_JSON"); return v; }
        void Space() { while(at<input.Length && " \t\r\n".IndexOf(input[at])>=0) at++; }
        bool Eat(char c) { Space(); if(at<input.Length && input[at]==c) { at++; return true; } return false; }
        string String() {
            Space(); Data.Need(at<input.Length && input[at++]=='"',"INVALID_JSON"); var b=new StringBuilder();
            while(at<input.Length) {
                char c=input[at++]; if(c=='"') return b.ToString(); Data.Need(c>=32,"INVALID_JSON");
                if(c!='\\') { b.Append(c); continue; }
                Data.Need(at<input.Length,"INVALID_JSON"); c=input[at++];
                switch(c) {
                    case '"': case '\\': case '/': b.Append(c); break;
                    case 'b': b.Append('\b'); break; case 'f': b.Append('\f'); break;
                    case 'n': b.Append('\n'); break; case 'r': b.Append('\r'); break; case 't': b.Append('\t'); break;
                    case 'u': Data.Need(at+4<=input.Length && Regex.IsMatch(input.Substring(at,4),"\\A[0-9a-fA-F]{4}\\z"),"INVALID_JSON"); b.Append((char)Convert.ToInt32(input.Substring(at,4),16)); at+=4; break;
                    default: throw new Denied("INVALID_JSON");
                }
            }
            throw new Denied("INVALID_JSON");
        }
        object Value(int depth) {
            Data.Need(depth<24,"JSON_DEPTH"); Space(); Data.Need(at<input.Length,"INVALID_JSON");
            if(input[at]=='"') return String();
            if(Eat('{')) { var d=new Dictionary<string,object>(StringComparer.Ordinal); if(Eat('}')) return d;
                do { string k=String(); Data.Need(!d.ContainsKey(k) && Eat(':'),"DUPLICATE_OR_INVALID_JSON_KEY"); d.Add(k,Value(depth+1)); if(Eat('}')) return d; } while(Eat(',')); throw new Denied("INVALID_JSON"); }
            if(Eat('[')) { var a=new List<object>(); if(Eat(']')) return a.ToArray(); do { a.Add(Value(depth+1)); if(Eat(']')) return a.ToArray(); } while(Eat(',')); throw new Denied("INVALID_JSON"); }
            foreach(string word in new[]{"true","false","null"}) if(input.Substring(at).StartsWith(word,StringComparison.Ordinal)) { at+=word.Length; return word=="null"?null:(object)(word=="true"); }
            var n=Regex.Match(input.Substring(at),"\\A-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?");
            Data.Need(n.Success,"INVALID_JSON"); at+=n.Length; decimal number;
            Data.Need(decimal.TryParse(n.Value,System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out number),"JSON_NUMBER_RANGE"); return number;
        }
    }

    internal sealed class CommandResult { internal int Exit; internal string Output; internal string Error; }
    internal interface ICommand { CommandResult Run(string args, string input, int seconds); }

    internal sealed class SshCommand : ICommand {
        internal const string Exe = @"C:\Windows\System32\OpenSSH\ssh.exe";
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a,string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int type,IntPtr info,uint size);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
        [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetEnvironmentStrings();
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool FreeEnvironmentStrings(IntPtr block);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool SetEnvironmentVariable(string name,string value);
        internal static void CleanProcessEnvironment() {
            // Only this provider process is changed. Never change user/system
            // environment, and never print or persist inherited values. Native
            // enumeration also handles duplicate differently-cased proxy names,
            // which break Framework ProcessStartInfo's dictionary initializer.
            IntPtr block=GetEnvironmentStrings(); Data.Need(block!=IntPtr.Zero,"ENVIRONMENT_ENUMERATION_FAILED");
            try {
                IntPtr p=block; var names=new List<string>(); string row;
                while((row=Marshal.PtrToStringUni(p)).Length>0) { int end=row.IndexOf('='); if(end>0) names.Add(row.Substring(0,end)); p=IntPtr.Add(p,(row.Length+1)*2); }
                foreach(string name in names) Data.Need(SetEnvironmentVariable(name,null),"ENVIRONMENT_SANITIZATION_FAILED");
            } finally { FreeEnvironmentStrings(block); }
            Data.Need(SetEnvironmentVariable("SystemRoot",@"C:\Windows") && SetEnvironmentVariable("SystemDrive","C:") && SetEnvironmentVariable("WINDIR",@"C:\Windows") && SetEnvironmentVariable("PATH",@"C:\Windows\System32") && SetEnvironmentVariable("USERPROFILE",@"C:\Users\Utente") && SetEnvironmentVariable("PROGRAMDATA",@"C:\ProgramData"),"ENVIRONMENT_SANITIZATION_FAILED");
        }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimit { internal long PerProcess,PerJob; internal uint Flags; internal UIntPtr MinWs,MaxWs; internal uint Active; internal UIntPtr Affinity; internal uint Priority,Scheduling; }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters { internal ulong A,B,C,D,E,F; }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { internal BasicLimit Basic; internal IoCounters Io; internal UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
        static string ReadBounded(StreamReader stream) { var b=new StringBuilder(); char[] buf=new char[4096]; int n; while((n=stream.Read(buf,0,buf.Length))>0) { if(b.Length+n>131072) throw new Denied("CHILD_OUTPUT_LIMIT"); b.Append(buf,0,n); } return b.ToString(); }
        public CommandResult Run(string args,string input,int seconds) { return RunContained(Exe,args,input,seconds); }
        // Internal seam used by a separate synthetic test executable only.
        // Production calls always pass Exe; no MCP field reaches this parameter.
        internal static CommandResult RunContained(string executable,string args,string input,int seconds) {
            CleanProcessEnvironment();
            IntPtr job=CreateJobObject(IntPtr.Zero,null); Data.Need(job!=IntPtr.Zero,"JOB_CREATION_FAILED");
            var limit=new ExtendedLimit(); limit.Basic.Flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int size=Marshal.SizeOf(limit); IntPtr block=Marshal.AllocHGlobal(size);
            try { Marshal.StructureToPtr(limit,block,false); Data.Need(SetInformationJobObject(job,9,block,(uint)size),"JOB_LIMIT_FAILED"); }
            catch { CloseHandle(job); throw; } finally { Marshal.FreeHGlobal(block); }
            var p=new Process();
            try {
                var si=new ProcessStartInfo(executable,args) { UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=Path.GetDirectoryName(executable) };
                si.EnvironmentVariables.Clear(); si.EnvironmentVariables["SystemRoot"]=@"C:\Windows";
                si.EnvironmentVariables["WINDIR"]=@"C:\Windows"; si.EnvironmentVariables["PATH"]=@"C:\Windows\System32";
                si.EnvironmentVariables["USERPROFILE"]=@"C:\Users\Utente";
                // Win32 OpenSSH exits silently with 255 if PROGRAMDATA is absent,
                // even for -G. Supply this fixed OS path, not inherited values.
                si.EnvironmentVariables["PROGRAMDATA"]=@"C:\ProgramData";
                // Framework SHGetFolderPath(CommonApplicationData) also needs
                // SystemDrive. Without it the historical core builds a relative
                // StateRoot and fails before SSH. Never inherit this value.
                si.EnvironmentVariables["SystemDrive"]="C:";
                p.StartInfo=si; Data.Need(p.Start(),"CHILD_START_FAILED");
                // No reviewed payload is sent until lifetime containment exists.
                if(!AssignProcessToJobObject(job,p.Handle)) { p.Kill(); p.WaitForExit(5000); throw new Denied("JOB_ASSIGN_FAILED"); }
                var stdout=Task.Run(()=>ReadBounded(p.StandardOutput)); var stderr=Task.Run(()=>ReadBounded(p.StandardError));
                var writer=Task.Run(()=>{ if(input!=null) p.StandardInput.Write(input); p.StandardInput.Close(); });
                var clock=Stopwatch.StartNew();
                while(!p.WaitForExit(50)) {
                    if(clock.Elapsed.TotalSeconds>seconds || stdout.IsFaulted || stderr.IsFaulted || writer.IsFaulted) {
                        Data.Need(TerminateJobObject(job,1) && p.WaitForExit(5000),"CHILD_SETTLEMENT_UNCERTAIN");
                        throw new Denied(clock.Elapsed.TotalSeconds>seconds?"CHANNEL_TIMEOUT":"CHILD_IO_FAILED");
                    }
                }
                Data.Need(Task.WaitAll(new Task[]{stdout,stderr,writer},5000),"CHILD_IO_UNSETTLED");
                return new CommandResult { Exit=p.ExitCode,Output=stdout.Result,Error=stderr.Result };
            } finally { CloseHandle(job); p.Dispose(); }
        }
    }

    internal static class Policy {
        internal const string Profile = @"C:\Users\Utente\.ssh\config";
        internal const string Options = "-T -o BatchMode=yes -o ConnectTimeout=15 -o ConnectionAttempts=1 -o CanonicalizeHostname=no -o StrictHostKeyChecking=yes -o CheckHostIP=no -o UpdateHostKeys=no -o UserKnownHostsFile=C:/Users/Utente/.ssh/known_hosts -o GlobalKnownHostsFile=none -o ServerAliveInterval=10 -o ServerAliveCountMax=2 -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no -o PermitLocalCommand=no -o ProxyCommand=none -o ProxyJump=none -o ControlMaster=no -o ControlPath=none -o ControlPersist=no -o IdentityAgent=none -o IdentitiesOnly=yes -o PreferredAuthentications=publickey -o PubkeyAuthentication=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o GSSAPIAuthentication=no -o HostbasedAuthentication=no";
        internal static readonly string Args = Options + " -F \"" + Profile + "\"";
        internal static void CheckProfile(string text) {
            Data.Need(!Regex.IsMatch(text,@"(?im)^\s*(Include|Match|ProxyCommand|ProxyJump|LocalCommand|KnownHostsCommand|PKCS11Provider|SecurityKeyProvider|RemoteCommand|SetEnv)(?:\s|=)") && text.IndexOf("FAI-Custodia",StringComparison.OrdinalIgnoreCase)<0,"OWNER_PROFILE_UNSUPPORTED_DIRECTIVE");
        }
        internal static string[] IdentityPaths(string text) {
            var fields=new Dictionary<string,List<string>>(StringComparer.Ordinal);
            foreach(string line in text.Split('\n')) { var parts=line.TrimEnd('\r').Split(new[]{' '},2); if(parts.Length!=2) continue; if(!fields.ContainsKey(parts[0])) fields[parts[0]]=new List<string>(); fields[parts[0]].Add(parts[1]); }
            foreach(var pair in new Dictionary<string,string>{{"hostname","desk.finanzaagevolaimpresa.it"},{"user","faiadmin"},{"port","22"}})
                Data.Need(fields.ContainsKey(pair.Key) && fields[pair.Key].Count==1 && fields[pair.Key][0]==pair.Value,"SSH_ALIAS_TARGET_MISMATCH");
            Data.Need(fields.ContainsKey("identityfile") && fields["identityfile"].Count>0,"SSH_IDENTITY_UNATTESTED");
            var paths=new List<string>();
            foreach(var file in fields["identityfile"]) {
                string v=file.Replace('/', '\\').Replace("~\\",@"C:\Users\Utente\");
                Data.Need(v.StartsWith(@"C:\Users\Utente\.ssh\",StringComparison.OrdinalIgnoreCase) && !v.Contains("..") && !v.Contains('%') && v.IndexOf("FAI-Custodia",StringComparison.OrdinalIgnoreCase)<0,"SSH_IDENTITY_SCOPE");
                paths.Add(v);
            }
            return paths.ToArray();
        }
        internal static void CheckAlias(string text,string owner) { foreach(string path in IdentityPaths(text)) OwnerFile(path,owner); }
        internal static void OwnerFile(string path,string owner) {
            NoLinks(path); ValidateAcl(File.GetAccessControl(path),owner,true);
            ValidateAcl(Directory.GetAccessControl(Path.GetDirectoryName(path)),owner,true);
        }
        internal static void NoLinks(string path) {
            for(string p=Path.GetFullPath(path); p!=null; p=Path.GetDirectoryName(p)) Data.Need((File.GetAttributes(p)&FileAttributes.ReparsePoint)==0,"REPARSE_POINT_DENIED");
        }
        internal static void Acl(string path,string ownerWrite=null) {
            NoLinks(path);
            FileSystemSecurity s=Directory.Exists(path)?(FileSystemSecurity)Directory.GetAccessControl(path):File.GetAccessControl(path);
            ValidateAcl(s,ownerWrite);
        }
        internal static void ValidateAcl(FileSystemSecurity s,string ownerWrite=null,bool allowOwnerAsOwner=false) {
            var owner=(SecurityIdentifier)s.GetOwner(typeof(SecurityIdentifier));
            Data.Need(owner.Value=="S-1-5-18" || owner.Value=="S-1-5-32-544" || allowOwnerAsOwner && owner.Value==ownerWrite,"INSTALL_OWNER_NOT_ADMINISTRATIVE");
            const FileSystemRights write=FileSystemRights.WriteData|FileSystemRights.AppendData|FileSystemRights.WriteExtendedAttributes|FileSystemRights.WriteAttributes|FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership;
            foreach(FileSystemAccessRule ace in s.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
                string sid=ace.IdentityReference.Value;
                if(ace.AccessControlType==AccessControlType.Allow && (ace.FileSystemRights&write)!=0)
                    Data.Need(sid=="S-1-5-18" || sid=="S-1-5-32-544" || sid==ownerWrite,"INSTALL_WRITABLE_BY_UNTRUSTED_PRINCIPAL");
            }
        }
        internal static string ErrorCategory(string stderr) {
            string s=stderr.ToLowerInvariant();
            if(s.Contains("could not resolve hostname") || s.Contains("no such host")) return "SSH_DNS_FAILED";
            if(s.Contains("host key verification failed") || s.Contains("remote host identification has changed")) return "SSH_HOST_KEY_FAILED";
            if(s.Contains("permission denied") || s.Contains("no supported authentication")) return "SSH_AUTHENTICATION_FAILED";
            if(s.Contains("connection timed out") || s.Contains("connection refused") || s.Contains("no route to host")) return "SSH_CONNECTION_FAILED";
            return "SSH_OR_REMOTE_COMMAND_FAILED";
        }
        internal static Dictionary<string,object> Minimize(string raw) {
            var d=Data.Obj(StrictJson.Parse(raw));
            var booleans=new HashSet<string>(new[]{"readOnly","runtimeMutationPerformed","secretValuesExported","agentRealKeyAccess","privateKeyFilesRead","baselineMatches","appHealthy","postgresHealthy","ledgerChecksumsMatch","zeroIncomplete","closedGates","releaseAdmitted","stepUpSecretConfigured","stepUpRegisteredActive","stepUpDigestMatches"});
            var integers=new HashSet<string>(new[]{"postgresRestartCount","ledgerCount","liveSessions","otherActiveDbSessions","availableBytes","stepUpActiveCount"});
            foreach(var pair in d) {
                if(booleans.Contains(pair.Key)) Data.Need(pair.Value is bool,"REMOTE_RECEIPT_TYPE");
                else if(integers.Contains(pair.Key)) Data.Need(pair.Value is decimal && (decimal)pair.Value>=0 && decimal.Truncate((decimal)pair.Value)==(decimal)pair.Value,"REMOTE_RECEIPT_TYPE");
                else if(pair.Key=="stepUpVersion") Data.Need(pair.Value==null || pair.Value is decimal && (decimal)pair.Value>0 && (decimal)pair.Value<1000000000 && decimal.Truncate((decimal)pair.Value)==(decimal)pair.Value,"REMOTE_RECEIPT_TYPE");
                else if(pair.Key=="code") Data.Need(Regex.IsMatch(Data.Text(pair.Value),"\\A[A-Z0-9_]{1,100}\\z"),"REMOTE_RECEIPT_VALUE");
                else if(pair.Key=="observedUtc" || pair.Key=="postgresStartedAt") Data.Need(Regex.IsMatch(Data.Text(pair.Value),"\\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+Z-]{8,32}\\z"),"REMOTE_RECEIPT_VALUE");
                else if(pair.Key=="protocol") Data.Need(Data.Text(pair.Value)=="FAI_M1_ADMISSION_OBSERVATION_R18","REMOTE_PROTOCOL");
                else if(pair.Key=="candidate") Data.Need(Data.Text(pair.Value)==Data.Candidate,"REMOTE_CANDIDATE");
                else if(pair.Key=="status") Data.Need(new[]{"STOP","OBSERVATION_COMPLETE"}.Contains(Data.Text(pair.Value)),"REMOTE_STATUS");
                else if(pair.Key=="recipientEvidence") Data.Need(Data.Text(pair.Value)=="UNATTESTED","REMOTE_RECIPIENT_STATUS");
                else if(pair.Key=="internalSessionMode") Data.Need(new[]{"legacy","registry"}.Contains(Data.Text(pair.Value)),"REMOTE_ACCESS_MODE");
                else if(pair.Key=="privilegedAccessMode") Data.Need(new[]{"disabled","enforced"}.Contains(Data.Text(pair.Value)),"REMOTE_ACCESS_MODE");
                else throw new Denied("REMOTE_RECEIPT_FIELD_DENIED");
            }
            foreach(string k in new[]{"protocol","candidate","status","observedUtc","readOnly","runtimeMutationPerformed","secretValuesExported","agentRealKeyAccess","privateKeyFilesRead"}) Data.Need(d.ContainsKey(k),"REMOTE_RECEIPT_INCOMPLETE");
            Data.Need((bool)d["readOnly"] && !(bool)d["runtimeMutationPerformed"] && !(bool)d["secretValuesExported"] && !(bool)d["agentRealKeyAccess"] && !(bool)d["privateKeyFilesRead"],"REMOTE_SAFETY_MISMATCH");
            if(Data.Text(d["status"])=="OBSERVATION_COMPLETE") {
                string[] successFields={"protocol","candidate","status","observedUtc","readOnly","runtimeMutationPerformed","secretValuesExported","agentRealKeyAccess","privateKeyFilesRead","baselineMatches","appHealthy","postgresHealthy","postgresStartedAt","postgresRestartCount","ledgerCount","ledgerChecksumsMatch","zeroIncomplete","closedGates","liveSessions","otherActiveDbSessions","availableBytes","recipientEvidence","releaseAdmitted","stepUpVersion","stepUpSecretConfigured","stepUpActiveCount","stepUpRegisteredActive","stepUpDigestMatches","internalSessionMode","privilegedAccessMode"};
                Data.Fields(d,successFields);
                Data.Need((bool)d["baselineMatches"] && (bool)d["appHealthy"] && (bool)d["postgresHealthy"] && (bool)d["ledgerChecksumsMatch"] && (bool)d["zeroIncomplete"] && (bool)d["closedGates"] && (decimal)d["ledgerCount"]==46 && !(bool)d["releaseAdmitted"],"REMOTE_SUCCESS_INCOMPLETE");
            } else Data.Need(d.Count==10 && d.ContainsKey("code"),"REMOTE_STOP_INCOMPLETE");
            return d;
        }
    }

    internal sealed class Executor {
        internal static readonly string InstallRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),Data.Namespace);
        internal static readonly string StateRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),Data.Namespace);
        readonly string processInstance=Guid.NewGuid().ToString("N");
        internal string Installation() {
            string exe=Assembly.GetExecutingAssembly().Location, dir=Path.GetDirectoryName(exe);
            Data.Need(Directory.GetParent(dir).FullName==InstallRoot && Regex.IsMatch(Path.GetFileName(dir),"\\A[0-9a-f]{16}\\z"),"REVIEWED_INSTALLATION_REQUIRED");
            Policy.Acl(InstallRoot); Policy.Acl(dir); Policy.Acl(exe);
            string admission=Path.Combine(dir,"install.json"); Policy.Acl(admission);
            var a=Data.Obj(StrictJson.Parse(File.ReadAllText(admission)));
            Data.Fields(a,"schema","ownerSid","exeSha256","profileSha256","sshSha256","reviewReference","approvedManifestSha256");
            Data.Need(Data.Text(a["schema"])=="FAI_M1_OBSERVE_INSTALL_R18","INSTALL_SCHEMA");
            string manifest=Path.Combine(dir,"manifest.json"); Policy.Acl(manifest);
            Data.Need(Data.FileSha(manifest)==Data.Text(a["approvedManifestSha256"]) && Path.GetFileName(dir)==Data.Text(a["approvedManifestSha256"]).Substring(0,16),"INSTALL_MANIFEST_BINDING");
            string owner=WindowsIdentity.GetCurrent().User.Value;
            Data.Need(owner==Data.Text(a["ownerSid"]) && WindowsIdentity.GetCurrent().Name.IndexOf("codexsandbox",StringComparison.OrdinalIgnoreCase)<0,"OWNER_CONTEXT_REQUIRED");
            Data.Need(new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)==false,"ELEVATED_RUNTIME_DENIED");
            Data.Need(Data.FileSha(exe)==Data.Text(a["exeSha256"]) && Data.FileSha(SshCommand.Exe)==Data.Text(a["sshSha256"]),"PROGRAM_HASH_CHANGED");
            Policy.OwnerFile(Policy.Profile,owner); Policy.OwnerFile(@"C:\Users\Utente\.ssh\known_hosts",owner);
            Data.Need(Data.FileSha(Policy.Profile)==Data.Text(a["profileSha256"]),"OWNER_PROFILE_CHANGED");
            string profile=File.ReadAllText(Policy.Profile);
            Policy.CheckProfile(profile);
            Data.Need(Regex.IsMatch(Data.Text(a["reviewReference"]),@"\A[A-Za-z0-9:/._#?=-]{10,240}\z"),"REVIEW_REFERENCE_REQUIRED");
            Policy.Acl(StateRoot,owner);
            return owner;
        }
        internal object Status() {
            string code="LOCAL_INSTALLATION_VERIFIED"; bool installed=false;
            try { Installation(); installed=true; } catch(Denied e) { code=e.Message; } catch { code="INSTALLATION_NOT_VERIFIED"; }
            return new { protocol="FAI_M1_EXECUTOR_STATUS_R18", candidate=Data.Candidate, processInstance, installed,
                code, executableSha256=Data.FileSha(Assembly.GetExecutingAssembly().Location),
                observerSha256=Data.Sha(Data.Resource("observer.py")),bindingSha256=Data.Sha(Data.Resource("binding.json")),
                productionMutationCapability=false, autonomousChannelQualified=false, agentRealKeyAccess=false };
        }
        internal object Observe(bool reconcile) {
            string owner=Installation();
            string lockPath=Path.Combine(StateRoot,"operation.lock"); if(File.Exists(lockPath)) Policy.NoLinks(lockPath);
            // A filesystem lock serializes different MCP processes too. No network listener.
            using(var serial=new FileStream(lockPath,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)) {
                string pending=Path.Combine(StateRoot,"pending.json");
                Data.Need(reconcile || !File.Exists(pending),"RECONCILIATION_REQUIRED");
                if(File.Exists(pending)) {
                    Policy.NoLinks(pending); Data.Need(new FileInfo(pending).Length<=4096,"PENDING_STATE_INVALID");
                    var old=Data.Obj(StrictJson.Parse(File.ReadAllText(pending)));
                    DateTime began=DateTime.MinValue;
                    Data.Need(old.ContainsKey("utc") && DateTime.TryParse(Data.Text(old["utc"]),null,System.Globalization.DateTimeStyles.RoundtripKind,out began),"PENDING_STATE_INVALID");
                    Data.Need(DateTime.UtcNow>=began.ToUniversalTime().AddSeconds(150),"PRIOR_OBSERVATION_WINDOW_OPEN");
                }
                string id=Guid.NewGuid().ToString("N");
                // Reconciliation records a fresh read; it never repeats a mutation.
                if(File.Exists(pending)) File.Move(pending,Path.Combine(StateRoot,"reconciled-"+id+".json"));
                File.WriteAllText(pending,Data.Encode(new { requestId=id,processInstance,operation=reconcile?"reconcile":"observe",utc=DateTime.UtcNow.ToString("o") }),new UTF8Encoding(false));
                object result;
                try {
                    var command=new SshCommand();
                    var profile=command.Run(Policy.Args+" -G fai-crm-prod",null,15);
                    Data.Need(profile.Exit==0,"SSH_OWNER_PROFILE_UNREADABLE"); Policy.CheckAlias(profile.Output,owner);
                    var code=Data.Resource("observer.py"); var binding=Data.Resource("binding.json");
                    string bootstrap="import base64,hashlib,json,sys\ncode=base64.b64decode('"+Convert.ToBase64String(code)+"',validate=True)\nassert hashlib.sha256(code).hexdigest()=='"+Data.Sha(code)+"'\nns={'__name__':'sealed_m1_observer'}\nexec(compile(code,'<sealed-m1-observer>','exec'),ns)\nsys.exit(ns['main'](json.loads(base64.b64decode('"+Convert.ToBase64String(binding)+"',validate=True))))\n";
                    var remote=command.Run(Policy.Args+" fai-crm-prod \"/usr/bin/python3 -I -B -u -\"",bootstrap,135);
                    Data.Need(remote.Exit==0 || remote.Exit==2,Policy.ErrorCategory(remote.Error));
                    var observation=Policy.Minimize(remote.Output.Trim());
                    bool ok=Data.Text(observation["status"])=="OBSERVATION_COMPLETE";
                    Data.Need((ok && remote.Exit==0)||(!ok && remote.Exit==2),"REMOTE_EXIT_STATUS_MISMATCH");
                    result=new { protocol="FAI_M1_EXECUTOR_RECEIPT_R18",requestId=id,processInstance,status=ok?"READ_CONFIRMED":"STOP",observation,agentRealKeyAccess=false,productionMutationPerformed=false };
                    if(!File.Exists(Path.Combine(StateRoot,"receipt-"+id+".json"))) WriteReceipt(id,result);
                    if(ok) File.Move(pending,Path.Combine(StateRoot,"completed-"+id+".json"));
                } catch(Exception e) {
                    string code=e is Denied?e.Message:"LOCAL_OPERATION_FAILED_REDACTED";
                    result=new { protocol="FAI_M1_EXECUTOR_RECEIPT_R18",requestId=id,processInstance,status="STOP",code,agentRealKeyAccess=false,productionMutationPerformed=false,reconciliationRequired=true };
                    if(!File.Exists(Path.Combine(StateRoot,"receipt-"+id+".json"))) WriteReceipt(id,result);
                }
                return result;
            }
        }
        static void WriteReceipt(string id,object result) {
            using(var f=new FileStream(Path.Combine(StateRoot,"receipt-"+id+".json"),FileMode.CreateNew,FileAccess.Write,FileShare.Read)) {
                byte[] bytes=Encoding.UTF8.GetBytes(Data.Encode(result)); f.Write(bytes,0,bytes.Length); f.Flush(true);
            }
        }
    }

    internal sealed class Server {
        readonly Executor executor=new Executor(); bool initialized;
        internal static readonly string[] Names={"fai_crm_m1_status","fai_crm_m1_observe","fai_crm_m1_reconcile"};
        internal static string ToolName(Dictionary<string,object> p) {
            Data.Need(p.ContainsKey("name") && p.Keys.All(k=>k=="name"||k=="arguments"||k=="_meta"),"TOOL_PARAMETERS_DENIED");
            string name=Data.Text(p["name"]); Data.Need(Names.Contains(name),"TOOL_NOT_ALLOWED");
            if(p.ContainsKey("arguments")) Data.Fields(Data.Obj(p["arguments"]));
            return name;
        }
        internal static object ToolResult(object value) {
            string text=Data.Encode(value);
            var fields=Data.Obj(StrictJson.Parse(text)); object status;
            bool failed=fields.TryGetValue("status",out status) && status is string && (string)status=="STOP";
            return new {content=new[]{new {type="text",text}},isError=failed};
        }
        internal object Dispatch(Dictionary<string,object> request) {
            string method=Data.Text(request["method"]);
            var p=request.ContainsKey("params")?Data.Obj(request["params"]):new Dictionary<string,object>();
            if(method=="initialize") { Data.Need(!initialized,"ALREADY_INITIALIZED"); initialized=true; return new {protocolVersion="2025-06-18",capabilities=new {tools=new {listChanged=false}},serverInfo=new {name="fai-crm-m1-owner",version="18.1.0"},instructions="Only fixed read-only M1 observations are available. No production mutation tools exist. Preserve custody restrictions. A STOP requires fai_crm_m1_reconcile before another observation. Local installation is not proof of an SSH connection or release readiness."}; }
            Data.Need(initialized,"INITIALIZE_REQUIRED");
            if(method=="ping") return new {};
            if(method=="tools/list") return new {tools=Names.Select(n=>new {name=n,description=n==Names[0]?"Read local installed capability status without opening SSH.":n==Names[1]?"Read the sealed PR139/schema46 target and minimized M1 prerequisites. No arguments or mutations.":"Reconcile a failed or uncertain observation with a fresh bounded read only.",inputSchema=new {type="object",properties=new {},additionalProperties=false},annotations=new {readOnlyHint=true,destructiveHint=false,idempotentHint=true,openWorldHint=n!=Names[0]}}).ToArray()};
            if(method=="tools/call") {
                try {
                    string name=ToolName(p); object value=name==Names[0]?executor.Status():executor.Observe(name==Names[2]);
                    return ToolResult(value);
                } catch(Exception e) { return new {content=new[]{new {type="text",text=Data.Encode(new {status="STOP",code=e is Denied?e.Message:"LOCAL_OPERATION_FAILED_REDACTED",productionMutationPerformed=false})}},isError=true}; }
            }
            throw new Denied("METHOD_NOT_SUPPORTED");
        }
        internal void Serve() {
            while(true) {
                string line=ReadLine(); if(line==null) return; object id=null;
                try {
                    var req=Data.Obj(StrictJson.Parse(line)); Data.Need(req.ContainsKey("jsonrpc") && Data.Text(req["jsonrpc"])=="2.0" && req.ContainsKey("method"),"INVALID_REQUEST");
                    if(!req.ContainsKey("id")) continue; id=req["id"]; Data.Need(id is string || id is decimal,"INVALID_ID");
                    Console.WriteLine(Data.Encode(new {jsonrpc="2.0",id,result=Dispatch(req)}));
                } catch { Console.WriteLine(Data.Encode(new {jsonrpc="2.0",id,error=new {code=-32600,message="Invalid or unsupported request"}})); }
            }
        }
        static string ReadLine() { var b=new StringBuilder(); int c; bool overflow=false; while((c=Console.In.Read())>=0 && c!='\n') { if(b.Length>=32768) overflow=true; else b.Append((char)c); } if(c<0 && b.Length==0) return null; return overflow?"!":b.ToString(); }
        public static int Main(string[] args) {
            if(args.Length!=0) return 2;
            Console.InputEncoding=new UTF8Encoding(false,true); Console.OutputEncoding=new UTF8Encoding(false);
            try { new Server().Serve(); return 0; } catch { return 2; }
        }
    }
}
