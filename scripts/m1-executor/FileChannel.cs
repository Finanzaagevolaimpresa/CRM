// Owner-run, fixed-operation transport for the separately installed 954db17 core.
// No listener, shell, plugin loading, command/path argument or production mutation.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Fai.M1 {
    internal static class ChannelBinding {
        internal const string Namespace = "FAI-CRM-M1-CHANNEL-R18";
        internal const string TaskId = "01a0c20b-b096-78a3-b6f6-db9153b914fe";
        internal const string Inbox = @"C:\Users\Utente\.codex\visualizations\2026\09\21\01a0c20b-b096-78a3-b6f6-db9153b914fe\m1-owner-channel-r18";
        internal const string State = @"C:\ProgramData\FAI-CRM-M1-CHANNEL-R18";
        internal const string Code = @"C:\Program Files\FAI-CRM-M1-CHANNEL-R18";
        internal const string Core = @"C:\Program Files\FAI-CRM-M1-R18\464a7cb3e2150491\M1Executor.exe";
        internal const string CoreSha = "d3a595e0abe96e0ceb78cdb62fc7981afc201e9520c61493c3c0a928dc82bb72";
        internal const string CoreManifest = "464a7cb3e2150491ef3c32f02406fecfccdf1f5e127988f0f31ba488b897e94e";
        internal const string ObserverSha = "79520da8edddb5f6e24b24c707d23828dd93492ee96300b30050cacdf78ceea3";
        internal const string BindingSha = "c1656cbdea66d8885727a86530d25058ab53de00e3736ece2a998be59f8bc1a2";
        internal static void HexId(string id) { Data.Need(Regex.IsMatch(id, @"\A[0-9a-f]{32}\z"), "REQUEST_ID_INVALID"); }
        internal static void CodeValue(object value) { Data.Need(Regex.IsMatch(Data.Text(value), @"\A[A-Z0-9_]{1,100}\z"), "PROVIDER_CODE_INVALID"); }
        internal static void False(Dictionary<string,object> d, string key) { Data.Need(d[key] is bool && !(bool)d[key], "PROVIDER_SAFETY_INVALID"); }
    }

    // Check metadata on the open handle before reading bytes. Hold all directory
    // ancestors without FILE_SHARE_DELETE to prevent path replacement while used.
    internal sealed class FileLease : IDisposable {
        [StructLayout(LayoutKind.Sequential)] internal struct Info {
            internal uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh;
            internal uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
            internal string Identity { get { return Volume.ToString("x8")+":"+IndexHigh.ToString("x8")+IndexLow.ToString("x8"); } }
        }
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
        static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
        [DllImport("kernel32.dll",SetLastError=true)]
        static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
        static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder path,uint size,uint flags);
        readonly List<SafeFileHandle> held=new List<SafeFileHandle>();
        internal string Identity;
        internal static SafeFileHandle Open(string path,bool directory,out Info info) {
            info=new Info();
            // GENERIC_READ is intentional: attribute-only handles do not enforce
            // the sharing restriction needed to prevent directory replacement.
            var h=CreateFile(path,0x80000000U,directory?3U:1U,IntPtr.Zero,3,0x00200000U|(directory?0x02000000U:0U),IntPtr.Zero);
            try {
                Data.Need(!h.IsInvalid && GetFileInformationByHandle(h,out info),"CHANNEL_FILE_OPEN_FAILED");
                Data.Need((info.Attributes&0x400)==0 && ((info.Attributes&0x10)!=0)==directory,"CHANNEL_LINK_OR_TYPE_DENIED");
                if(!directory) Data.Need(info.Links==1,"CHANNEL_HARDLINK_DENIED");
                var name=new StringBuilder(1024);
                uint n=GetFinalPathNameByHandle(h,name,1024,0);
                Data.Need(n>0 && n<1024 && String.Equals(name.ToString(),@"\\?\"+Path.GetFullPath(path),StringComparison.OrdinalIgnoreCase),"CHANNEL_PATH_CHANGED");
                return h;
            } catch { h.Dispose(); throw; }
        }
        internal static FileLease Directory(string path) {
            var lease=new FileLease();
            try {
                var chain=new List<string>();
                for(string p=Path.GetFullPath(path);p!=null;p=Path.GetDirectoryName(p)) chain.Add(p);
                chain.Reverse();
                foreach(string p in chain) { Info info; lease.held.Add(Open(p,true,out info)); lease.Identity=info.Identity; }
                return lease;
            } catch { lease.Dispose(); throw; }
        }
        internal static string Read(string path,int limit) {
            Info info;
            using(var h=Open(path,false,out info)) {
                Data.Need(info.SizeHigh==0 && info.SizeLow<=limit,"CHANNEL_FILE_SIZE");
                using(var stream=new FileStream(h,FileAccess.Read))
                using(var reader=new StreamReader(stream,new UTF8Encoding(false,true),false)) {
                    string text=reader.ReadToEnd();
                    Data.Need(Encoding.UTF8.GetByteCount(text)<=limit,"CHANNEL_FILE_SIZE");
                    return text;
                }
            }
        }
        public void Dispose() { for(int i=held.Count-1;i>=0;i--) held[i].Dispose(); held.Clear(); }
    }

    // Called only by the explicitly approved installer, after it has verified
    // this assembly's bytes. No arguments and no connection or credential reads.
    public static class FileChannelInstallSupport {
        [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { internal int Length;internal IntPtr Descriptor;internal int InheritHandle; }
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
        static extern bool CreateDirectory(string path,ref SecurityAttributes attributes);
        internal static void CreateExclusive(string path,byte[] descriptor) {
            IntPtr bytes=Marshal.AllocHGlobal(descriptor.Length);
            try {
                Marshal.Copy(descriptor,0,bytes,descriptor.Length);
                var attributes=new SecurityAttributes{Length=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=bytes,InheritHandle=0};
                // Unlike Directory.CreateDirectory, fail if another process won
                // the creation race; never inherit an attacker's existing DACL.
                Data.Need(CreateDirectory(path,ref attributes),"CHANNEL_DIRECTORY_CREATION_REFUSED");
            } finally { Marshal.FreeHGlobal(bytes); }
        }
        public static void CreateProtectedDirectory(string path,byte[] descriptor) {
            string exact=Path.GetFullPath(path);
            Data.Need(exact==ChannelBinding.Code || exact==ChannelBinding.State || exact==ChannelBinding.Inbox ||
                Path.GetDirectoryName(exact)==ChannelBinding.Code && Regex.IsMatch(Path.GetFileName(exact),@"\A[0-9a-f]{16}\z"),"INSTALL_DIRECTORY_SCOPE");
            CreateExclusive(exact,descriptor);
        }
        public static string InboxIdentity() { using(var d=FileLease.Directory(ChannelBinding.Inbox)) return d.Identity; }
        public static IDisposable HoldInstallationParents() {
            return new ParentLocks();
        }
        sealed class ParentLocks : IDisposable {
            readonly List<FileLease> leases=new List<FileLease>();
            internal ParentLocks() {
                try {
                    foreach(string root in new[]{ChannelBinding.Code,ChannelBinding.State,ChannelBinding.Inbox})
                        leases.Add(FileLease.Directory(Path.GetDirectoryName(root)));
                } catch { Dispose(); throw; }
            }
            public void Dispose() { foreach(var lease in leases) lease.Dispose(); leases.Clear(); }
        }
    }

    internal sealed class ChannelRequest {
        internal string Id,Operation,Session;
        internal static ChannelRequest Parse(string text,string session,DateTime now) {
            Data.Need(Encoding.UTF8.GetByteCount(text)<=2048,"REQUEST_SIZE");
            var d=Data.Obj(StrictJson.Parse(text));
            Data.Fields(d,"protocol","candidate","taskId","sessionId","requestId","operation","expiresUtc");
            Data.Need(Data.Text(d["protocol"])=="FAI_M1_FILE_REQUEST_R18" && Data.Text(d["candidate"])==Data.Candidate &&
                Data.Text(d["taskId"])==ChannelBinding.TaskId,"REQUEST_SCOPE");
            string id=Data.Text(d["requestId"]),op=Data.Text(d["operation"]),sid=Data.Text(d["sessionId"]);
            ChannelBinding.HexId(id); ChannelBinding.HexId(sid);
            Data.Need(sid==session,"STALE_CHANNEL_SESSION");
            Data.Need(new[]{"status","observe","reconcile"}.Contains(op),"OPERATION_NOT_ALLOWED");
            DateTime expiry;
            Data.Need(DateTime.TryParseExact(Data.Text(d["expiresUtc"]),"yyyy-MM-ddTHH:mm:ssZ",System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AssumeUniversal|System.Globalization.DateTimeStyles.AdjustToUniversal,out expiry) &&
                expiry>now && expiry<=now.AddMinutes(5),"REQUEST_EXPIRED_OR_INVALID");
            return new ChannelRequest{Id=id,Operation=op,Session=sid};
        }
    }

    internal interface IChannelProvider { Dictionary<string,object> Call(string operation); }
    internal sealed class SealedProvider : IChannelProvider {
        internal static string Input(string operation) {
            Data.Need(new[]{"status","observe","reconcile"}.Contains(operation),"OPERATION_NOT_ALLOWED");
            return Data.Encode(new{jsonrpc="2.0",id=1,method="initialize",@params=new{protocolVersion="2025-06-18",capabilities=new{},clientInfo=new{name="fai-m1-file-channel",version="18.1.0"}}})+"\n"+
                Data.Encode(new{jsonrpc="2.0",method="notifications/initialized"})+"\n"+
                Data.Encode(new{jsonrpc="2.0",id=2,method="tools/call",@params=new{name="fai_crm_m1_"+operation,arguments=new{}}})+"\n";
        }
        internal static Dictionary<string,object> Validate(Dictionary<string,object> d,string operation) {
            if(!d.ContainsKey("protocol")) {
                Data.Fields(d,"status","code","productionMutationPerformed");
                Data.Need(Data.Text(d["status"])=="STOP","PROVIDER_STOP_INVALID"); ChannelBinding.CodeValue(d["code"]);
                ChannelBinding.False(d,"productionMutationPerformed"); return d;
            }
            string protocol=Data.Text(d["protocol"]);
            if(operation=="status") {
                Data.Fields(d,"protocol","candidate","processInstance","installed","code","executableSha256","observerSha256","bindingSha256",
                    "productionMutationCapability","autonomousChannelQualified","agentRealKeyAccess");
                Data.Need(protocol=="FAI_M1_EXECUTOR_STATUS_R18" && Data.Text(d["candidate"])==Data.Candidate &&
                    d["installed"] is bool && Data.Text(d["executableSha256"])==ChannelBinding.CoreSha &&
                    Data.Text(d["observerSha256"])==ChannelBinding.ObserverSha && Data.Text(d["bindingSha256"])==ChannelBinding.BindingSha,"PROVIDER_STATUS_INVALID");
                ChannelBinding.HexId(Data.Text(d["processInstance"])); ChannelBinding.CodeValue(d["code"]);
                ChannelBinding.False(d,"productionMutationCapability"); ChannelBinding.False(d,"autonomousChannelQualified"); ChannelBinding.False(d,"agentRealKeyAccess");
                Data.Need(!(bool)d["installed"] || Data.Text(d["code"])=="LOCAL_INSTALLATION_VERIFIED","PROVIDER_STATUS_INVALID");
                return d;
            }
            Data.Need(protocol=="FAI_M1_EXECUTOR_RECEIPT_R18","PROVIDER_PROTOCOL");
            ChannelBinding.HexId(Data.Text(d["requestId"])); ChannelBinding.HexId(Data.Text(d["processInstance"]));
            ChannelBinding.False(d,"agentRealKeyAccess"); ChannelBinding.False(d,"productionMutationPerformed");
            string status=Data.Text(d["status"]); Data.Need(status=="STOP" || status=="READ_CONFIRMED","PROVIDER_STATUS_INVALID");
            if(d.ContainsKey("observation")) {
                Data.Fields(d,"protocol","requestId","processInstance","status","observation","agentRealKeyAccess","productionMutationPerformed");
                var observation=Policy.Minimize(Data.Encode(d["observation"]));
                Data.Need((status=="READ_CONFIRMED")== (Data.Text(observation["status"])=="OBSERVATION_COMPLETE"),"PROVIDER_OBSERVATION_STATUS");
            } else {
                Data.Fields(d,"protocol","requestId","processInstance","status","code","agentRealKeyAccess","productionMutationPerformed","reconciliationRequired");
                ChannelBinding.CodeValue(d["code"]);
                Data.Need(status=="STOP" && d["reconciliationRequired"] is bool && (bool)d["reconciliationRequired"],"PROVIDER_STOP_INVALID");
            }
            return d;
        }
        internal static Dictionary<string,object> Parse(CommandResult child,string operation) {
            Data.Need(child.Exit==0 && String.IsNullOrEmpty(child.Error),"PROVIDER_EXIT_OR_STDERR");
            string[] lines=child.Output.Split(new[]{'\n'},StringSplitOptions.RemoveEmptyEntries);
            Data.Need(lines.Length==2,"PROVIDER_RESPONSE_COUNT");
            var first=Data.Obj(StrictJson.Parse(lines[0])); var second=Data.Obj(StrictJson.Parse(lines[1]));
            Data.Fields(first,"jsonrpc","id","result"); Data.Fields(second,"jsonrpc","id","result");
            Data.Need(Data.Text(first["jsonrpc"])=="2.0" && Data.Text(second["jsonrpc"])=="2.0" &&
                first["id"] is decimal && (decimal)first["id"]==1 && second["id"] is decimal && (decimal)second["id"]==2,"PROVIDER_RPC_ENVELOPE");
            var init=Data.Obj(first["result"]);
            Data.Need(init.ContainsKey("protocolVersion") && Data.Text(init["protocolVersion"])=="2025-06-18","PROVIDER_INITIALIZE");
            var result=Data.Obj(second["result"]); Data.Fields(result,"content","isError");
            Data.Need(result["isError"] is bool && result["content"] is object[],"PROVIDER_RESULT");
            var content=(object[])result["content"]; Data.Need(content.Length==1,"PROVIDER_RESULT");
            var item=Data.Obj(content[0]); Data.Fields(item,"type","text"); Data.Need(Data.Text(item["type"])=="text","PROVIDER_RESULT");
            var payload=Validate(Data.Obj(StrictJson.Parse(Data.Text(item["text"]))),operation);
            bool stopped=payload.ContainsKey("status") && Data.Text(payload["status"])=="STOP";
            Data.Need((bool)result["isError"]==stopped,"PROVIDER_ERROR_FLAG"); return payload;
        }
        public Dictionary<string,object> Call(string operation) {
            Policy.Acl(Path.GetDirectoryName(ChannelBinding.Core)); Policy.Acl(ChannelBinding.Core);
            string manifest=Path.Combine(Path.GetDirectoryName(ChannelBinding.Core),"manifest.json"); Policy.Acl(manifest);
            Data.Need(Data.FileSha(ChannelBinding.Core)==ChannelBinding.CoreSha && Data.FileSha(manifest)==ChannelBinding.CoreManifest,"CORE_BINDING_CHANGED");
            return Parse(SshCommand.RunContained(ChannelBinding.Core,"",Input(operation),170),operation);
        }
    }

    internal sealed class ChannelEngine {
        readonly string state,session; readonly IChannelProvider provider;
        internal ChannelEngine(string state,string session,IChannelProvider provider) { this.state=state;this.session=session;this.provider=provider; }
        internal static void WriteNew(string path,object value) {
            byte[] bytes=Encoding.UTF8.GetBytes(Data.Encode(value));
            // Publish only complete bytes. Unique staging avoids a permanent
            // collision after interruption; recovery retains every partial file.
            Data.Need(!File.Exists(path),"CHANNEL_RECORD_EXISTS");
            string staging=path+"."+Guid.NewGuid().ToString("N")+".writing";
            using(var f=new FileStream(staging,FileMode.CreateNew,FileAccess.Write,FileShare.None)) { f.Write(bytes,0,bytes.Length); f.Flush(true); }
            File.Move(staging,path);
        }
        string ReceiptPath(string id) { ChannelBinding.HexId(id); return Path.Combine(state,"receipt-"+id+".json"); }
        internal bool HasReceipt(string id) { return File.Exists(ReceiptPath(id)); }
        internal bool Gated { get { return File.Exists(Path.Combine(state,"pending.json")) || File.Exists(Path.Combine(state,"stop.json")) ||
            Directory.GetFiles(state,"*.writing").Length!=0 || Directory.GetFiles(state,"unreconciled-*.partial").Length!=0; } }
        // Called only while the lifetime channel lock is held. Do not read,
        // promote, overwrite or delete interrupted bytes. Their names retain the
        // logical record/nonce, and their presence itself is a durable STOP gate.
        internal void RecoverPublications() {
            foreach(string path in Directory.GetFiles(state,"*.writing")) {
                var name=Regex.Match(Path.GetFileName(path),@"\A(ready|pending|stop|claim-[0-9a-f]{32}|receipt-[0-9a-f]{32}|rejected-[0-9a-f]{32}|stopped-[0-9a-f]{32})\.json(?:\.[0-9a-f]{32})?\.writing\z");
                Data.Need(name.Success,"UNRECOGNIZED_STAGING_RECORD");
                File.Move(path,Path.Combine(state,"unreconciled-"+name.Groups[1].Value+".json-"+Guid.NewGuid().ToString("N")+".partial"));
            }
        }
        bool Claimed(string id) {
            // Also reserve nonces whose claim publication was interrupted, even
            // after its partial bytes have been archived by reconciliation.
            return Directory.GetFiles(state,"*claim-"+id+".json*").Length!=0;
        }
        internal void Process(ChannelRequest r) {
            Data.Need(r.Session==session,"STALE_CHANNEL_SESSION"); ChannelBinding.HexId(r.Id);
            RecoverPublications();
            if(HasReceipt(r.Id)) return; // The immutable receipt is the only replay answer.
            string claim=Path.Combine(state,"claim-"+r.Id+".json"),pending=Path.Combine(state,"pending.json"),stop=Path.Combine(state,"stop.json");
            bool gated=Gated;
            Data.Need(!Claimed(r.Id),"CLAIM_WITHOUT_RECEIPT_RECONCILE");
            WriteNew(claim,new{protocol="FAI_M1_CHANNEL_CLAIM_R18",requestId=r.Id,sessionId=session,operation=r.Operation,utc=DateTime.UtcNow.ToString("o")});
            string code=null; Dictionary<string,object> result=null; bool ok=false,called=false;
            try {
                Data.Need(r.Operation=="status" || r.Operation=="reconcile" || !gated,"RECONCILIATION_REQUIRED");
                if(r.Operation!="status") {
                    if(File.Exists(pending)) File.Move(pending,Path.Combine(state,"pending-reconciled-"+r.Id+".json"));
                    WriteNew(pending,new{requestId=r.Id,sessionId=session,operation=r.Operation,utc=DateTime.UtcNow.ToString("o")});
                }
                called=true; result=provider.Call(r.Operation);
                ok=r.Operation=="status"?result.ContainsKey("installed") && (bool)result["installed"]:
                    result.ContainsKey("status") && Data.Text(result["status"])=="READ_CONFIRMED";
                if(!ok) code="PROVIDER_STOP";
            } catch(Exception e) { code=e is Denied?e.Message:"CHANNEL_OPERATION_FAILED_REDACTED"; }
            if(!ok && !File.Exists(stop)) WriteNew(stop,new{requestId=r.Id,code=code??"CHANNEL_STOP",utc=DateTime.UtcNow.ToString("o")});
            // Never copy raw stdout/stderr, exception text or request bodies.
            WriteNew(ReceiptPath(r.Id),new{protocol="FAI_M1_FILE_RECEIPT_R18",candidate=Data.Candidate,taskId=ChannelBinding.TaskId,
                requestId=r.Id,sessionId=session,operation=r.Operation,status=ok?"OK":"STOP",code,
                providerCalled=called,result,utc=DateTime.UtcNow.ToString("o"),readOnly=true,agentRealKeyAccess=false,productionMutationPerformed=false});
            if(ok && r.Operation!="status") {
                if(File.Exists(pending)) File.Move(pending,Path.Combine(state,"pending-completed-"+r.Id+".json"));
                if(r.Operation=="reconcile") {
                    if(File.Exists(stop)) File.Move(stop,Path.Combine(state,"stop-reconciled-"+r.Id+".json"));
                    foreach(string partial in Directory.GetFiles(state,"unreconciled-*.partial"))
                        File.Move(partial,Path.Combine(state,"reconciled-"+r.Id+"-"+Path.GetFileName(partial).Substring("unreconciled-".Length)));
                }
            }
        }
    }

    internal static class FileChannel {
        static string Admission(out string manifestHash) {
            string exe=Assembly.GetExecutingAssembly().Location,dir=Path.GetDirectoryName(exe);
            Data.Need(Directory.GetParent(dir).FullName==ChannelBinding.Code && Regex.IsMatch(Path.GetFileName(dir),@"\A[0-9a-f]{16}\z"),"REVIEWED_CHANNEL_INSTALLATION_REQUIRED");
            Policy.Acl(ChannelBinding.Code); Policy.Acl(dir); Policy.Acl(exe);
            string install=Path.Combine(dir,"install.json"),manifest=Path.Combine(dir,"manifest.json");
            Policy.Acl(install); Policy.Acl(manifest);
            var a=Data.Obj(StrictJson.Parse(FileLease.Read(install,4096)));
            Data.Fields(a,"schema","ownerSid","manifestSha256","exeSha256","inboxIdentity","reviewReference");
            Data.Need(Data.Text(a["schema"])=="FAI_M1_FILE_CHANNEL_INSTALL_R18","CHANNEL_INSTALL_SCHEMA");
            manifestHash=Data.Text(a["manifestSha256"]);
            Data.Need(Regex.IsMatch(manifestHash,@"\A[0-9a-f]{64}\z") && manifestHash.Substring(0,16)==Path.GetFileName(dir) &&
                Data.FileSha(manifest)==manifestHash && Data.FileSha(exe)==Data.Text(a["exeSha256"]),"CHANNEL_PROGRAM_HASH_CHANGED");
            string owner=WindowsIdentity.GetCurrent().User.Value;
            Data.Need(owner==Data.Text(a["ownerSid"]) && WindowsIdentity.GetCurrent().Name.IndexOf("codexsandbox",StringComparison.OrdinalIgnoreCase)<0,"OWNER_CONTEXT_REQUIRED");
            Data.Need(!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator),"ELEVATED_RUNTIME_DENIED");
            string coreInstall=Path.Combine(Path.GetDirectoryName(ChannelBinding.Core),"install.json"); Policy.Acl(coreInstall);
            var core=Data.Obj(StrictJson.Parse(FileLease.Read(coreInstall,4096)));
            Data.Need(Data.Text(core["ownerSid"])==owner && Data.Text(core["approvedManifestSha256"])==ChannelBinding.CoreManifest,"CORE_OWNER_BINDING_CHANGED");
            Policy.Acl(ChannelBinding.State,owner);
            return Data.Text(a["inboxIdentity"]);
        }
        public static int Main(string[] args) {
            if(args.Length!=0) return 2;
            try {
                string manifestHash; string inboxIdentity=Admission(out manifestHash);
                using(var inbox=FileLease.Directory(ChannelBinding.Inbox))
                using(var state=FileLease.Directory(ChannelBinding.State)) {
                    Data.Need(inbox.Identity==inboxIdentity,"INBOX_IDENTITY_CHANGED");
                    using(var serial=new FileStream(Path.Combine(ChannelBinding.State,"channel.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)) {
                        string session=Guid.NewGuid().ToString("N"),ready=Path.Combine(ChannelBinding.State,"ready.json");
                        var engine=new ChannelEngine(ChannelBinding.State,session,new SealedProvider());
                        engine.RecoverPublications();
                        if(File.Exists(ready)) File.Move(ready,Path.Combine(ChannelBinding.State,"ready-before-"+session+".json"));
                        ChannelEngine.WriteNew(ready,new{protocol="FAI_M1_FILE_CHANNEL_READY_R18",candidate=Data.Candidate,taskId=ChannelBinding.TaskId,
                            sessionId=session,manifestSha256=manifestHash,startedUtc=DateTime.UtcNow.ToString("o"),readOnly=true,productionMutationCapability=false,
                            autonomousChannelQualified=false,agentRealKeyAccess=false,reconciliationRequired=engine.Gated});
                        string lastRejected=null; int handled=0;
                        while(!File.Exists(Path.Combine(ChannelBinding.State,"owner-stop.json"))) {
                            string request=Path.Combine(ChannelBinding.Inbox,"request.json");
                            if(File.Exists(request)) {
                                string raw=null;
                                try {
                                    raw=FileLease.Read(request,2048);
                                    // A replay remains answered even after its expiry. Never call the
                                    // provider again, and never trust an unvalidated path from the request.
                                    var prior=Data.Obj(StrictJson.Parse(raw));
                                    string id=prior.ContainsKey("requestId")?Data.Text(prior["requestId"]):"";
                                    ChannelBinding.HexId(id);
                                    if(!engine.HasReceipt(id)) {
                                        var r=ChannelRequest.Parse(raw,session,DateTime.UtcNow);
                                        Data.Need(++handled<=128,"SESSION_REQUEST_LIMIT");
                                        engine.Process(r);
                                    }
                                } catch(Exception e) {
                                    string fingerprint=Data.Sha(Encoding.UTF8.GetBytes(raw??"FILE_UNREADABLE"));
                                    if(fingerprint!=lastRejected) {
                                        lastRejected=fingerprint;
                                        ChannelEngine.WriteNew(Path.Combine(ChannelBinding.State,"rejected-"+Guid.NewGuid().ToString("N")+".json"),
                                            new{protocol="FAI_M1_CHANNEL_REJECTED_R18",code=e is Denied?e.Message:"CHANNEL_INPUT_REJECTED_REDACTED",
                                                sessionId=session,utc=DateTime.UtcNow.ToString("o"),providerOutcome="CHECK_CLAIM_AND_RECEIPT",
                                                agentRealKeyAccess=false,productionMutationPerformed=false});
                                    }
                                }
                            }
                            Thread.Sleep(1000);
                        }
                        ChannelEngine.WriteNew(Path.Combine(ChannelBinding.State,"stopped-"+session+".json"),new{protocol="FAI_M1_CHANNEL_STOPPED_R18",sessionId=session,utc=DateTime.UtcNow.ToString("o")});
                    }
                }
                return 0;
            } catch { return 2; } // Startup failures never expose paths, profile text or credentials.
        }
    }
}
