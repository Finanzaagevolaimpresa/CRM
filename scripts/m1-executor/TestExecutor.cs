// Separate test entry point; it is not included in the installed executable.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using Fai.M1;

internal static class TestExecutor {
    static int tests;
    static void Assert(bool value,string name) { if(!value) throw new Exception(name); tests++; }
    static void Reject(Action action,string name) { try { action(); } catch(Denied) { tests++; return; } throw new Exception(name); }
    static string Alias(string host="desk.finanzaagevolaimpresa.it",string user="faiadmin",string identity="~/.ssh/fai_crm_prod_ed25519") {
        return "hostname "+host+"\nuser "+user+"\nport 22\nidentityfile "+identity+"\n";
    }
    public static int Main(string[] args) {
        try {
            foreach(string text in new[]{"{\"x\":1,\"x\":2}","{\"x\":NaN}","[1,]","{\"x\":1}junk","{\"x\":01}","{\"x\":1e999}"})
                Reject(()=>StrictJson.Parse(text),"invalid JSON accepted");
            Assert(Data.Obj(StrictJson.Parse("{\"x\":true}"))["x"] is bool,"JSON boolean");
            Assert(Policy.IdentityPaths(Alias()).Length==1,"fixed alias");
            Reject(()=>Policy.IdentityPaths(Alias("elsewhere.example")),"wrong target");
            Reject(()=>Policy.IdentityPaths(Alias(user:"root")),"wrong user");
            Reject(()=>Policy.IdentityPaths(Alias(identity:"C:/Users/Utente/FAI-Custodia/key")),"custody identity");
            Reject(()=>Policy.IdentityPaths(Alias(identity:"~/.ssh/../../secret")),"traversal");
            Reject(()=>Policy.IdentityPaths(Alias()+"hostname evil.example\n"),"duplicate target");
            foreach(string name in new[]{"shell","deploy","backup","fai_crm_m1_run"})
                Reject(()=>Server.ToolName(new Dictionary<string,object>{{"name",name}}),"extra capability");
            Reject(()=>Server.ToolName(new Dictionary<string,object>{{"name",Server.Names[1]},{"arguments",new Dictionary<string,object>{{"command","id"}}}}),"command injection");
            Reject(()=>Server.ToolName(new Dictionary<string,object>{{"name",Server.Names[1]},{"arguments",new Dictionary<string,object>{{"path","C:\\secret"}}}}),"path injection");
            Assert(Server.ToolName(new Dictionary<string,object>{{"name",Server.Names[1]},{"arguments",new Dictionary<string,object>()}})==Server.Names[1],"empty args");
            var acl=new DirectorySecurity(); acl.SetOwner(new SecurityIdentifier("S-1-5-32-544"));
            acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-5-18"),FileSystemRights.FullControl,AccessControlType.Allow));
            Policy.ValidateAcl(acl); tests++;
            acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-5-32-545"),FileSystemRights.WriteData,AccessControlType.Allow));
            Reject(()=>Policy.ValidateAcl(acl),"untrusted writable code");
            Assert(Policy.ErrorCategory("Host key verification failed") == "SSH_HOST_KEY_FAILED","host key class");
            Assert(Policy.ErrorCategory("Permission denied (publickey)")=="SSH_AUTHENTICATION_FAILED","authentication class");
            Assert(Policy.ErrorCategory("sensitive unrelated text")=="SSH_OR_REMOTE_COMMAND_FAILED","stderr redaction");
            var stop=new Dictionary<string,object>{{"protocol","FAI_M1_ADMISSION_OBSERVATION_R18"},{"candidate",Data.Candidate},{"status","STOP"},{"observedUtc","2026-09-25T10:00:00+00:00"},{"readOnly",true},{"runtimeMutationPerformed",false},{"secretValuesExported",false},{"agentRealKeyAccess",false},{"privateKeyFilesRead",false},{"code","TARGET_IDENTITY_MISMATCH"}};
            Assert(Policy.Minimize(Data.Encode(stop)).Count==10,"minimized stop");
            stop["environment"]="sensitive"; Reject(()=>Policy.Minimize(Data.Encode(stop)),"extra output field"); stop.Remove("environment");
            stop["code"]="password=hidden"; Reject(()=>Policy.Minimize(Data.Encode(stop)),"raw error denied"); stop["code"]="TARGET_IDENTITY_MISMATCH";
            stop["secretValuesExported"]=true; Reject(()=>Policy.Minimize(Data.Encode(stop)),"unsafe receipt");
            var success=Policy.Minimize(File.ReadAllText(args[0]));
            Assert((string)success["status"]=="OBSERVATION_COMPLETE" && (bool)success["stepUpDigestMatches"],"actual observer receipt accepted");
            success["releaseAdmitted"]=true; Reject(()=>Policy.Minimize(Data.Encode(success)),"observation must never admit release");
            Assert((bool)Data.Obj(StrictJson.Parse(Data.Encode(Server.ToolResult(new {status="STOP",code="SSH_DNS_FAILED"}))))["isError"],"STOP is a tool error");
            Assert(!(bool)Data.Obj(StrictJson.Parse(Data.Encode(Server.ToolResult(new {status="READ_CONFIRMED"}))))["isError"],"read success is not a tool error");
            string child=Path.Combine(Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location),"TestChild.exe");
            Assert(SshCommand.RunContained(child,"echo","synthetic-input",5).Output=="synthetic-input","bounded process input/output");
            Reject(()=>SshCommand.RunContained(child,"overflow",null,5),"unbounded child output");
            string pidFile=Path.Combine(Path.GetDirectoryName(child),"descendant.pid");
            var clock=Stopwatch.StartNew();
            Reject(()=>SshCommand.RunContained(child,"descendant \""+pidFile+"\"",null,1),"child deadline");
            Assert(clock.Elapsed.TotalSeconds<8,"bounded settlement");
            int childPid=int.Parse(File.ReadAllText(pidFile)); bool gone=false;
            try { using(var descendant=Process.GetProcessById(childPid)) gone=descendant.WaitForExit(3000); } catch(ArgumentException) { gone=true; }
            Assert(gone,"descendant terminated with job");
            Console.WriteLine(Data.Encode(new {status="SYNTHETIC_TESTS_PASS",tests,remoteConnectionAttempted=false,installationPerformed=false})); return 0;
        } catch(Exception e) { Console.WriteLine(Data.Encode(new {status="SYNTHETIC_TEST_FAILED",test=e.Message})); return 1; }
    }
}
