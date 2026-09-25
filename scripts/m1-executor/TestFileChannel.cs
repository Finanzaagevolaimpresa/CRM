using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using Fai.M1;

internal static class TestFileChannel {
    static int passed;
    static readonly string Session=new string('a',32);
    static readonly DateTime Now=new DateTime(2026,9,25,12,0,0,DateTimeKind.Utc);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern bool CreateHardLink(string file,string existing,IntPtr security);
    static void Check(bool value,string message) { if(!value) throw new Exception(message); passed++; }
    static void Reject(Action action,string expected) {
        try { action(); } catch(Denied e) { Check(e.Message==expected,"Unexpected denial: "+e.Message+" expected "+expected);return; }
        throw new Exception("Not rejected: "+expected);
    }
    static Dictionary<string,object> Request(string op="observe",string id=null) {
        return new Dictionary<string,object>{{"protocol","FAI_M1_FILE_REQUEST_R18"},{"candidate",Data.Candidate},{"taskId",ChannelBinding.TaskId},
            {"sessionId",Session},{"requestId",id??Guid.NewGuid().ToString("N")},{"operation",op},{"expiresUtc",Now.AddMinutes(3).ToString("yyyy-MM-ddTHH:mm:ssZ")}};
    }
    static ChannelRequest Parsed(string op="observe",string id=null) { return ChannelRequest.Parse(Data.Encode(Request(op,id)),Session,Now); }
    static Dictionary<string,object> Status() {
        return new Dictionary<string,object>{{"protocol","FAI_M1_EXECUTOR_STATUS_R18"},{"candidate",Data.Candidate},
            {"processInstance",new string('b',32)},{"installed",true},{"code","LOCAL_INSTALLATION_VERIFIED"},
            {"executableSha256",ChannelBinding.CoreSha},{"observerSha256",ChannelBinding.ObserverSha},{"bindingSha256",ChannelBinding.BindingSha},
            {"productionMutationCapability",false},{"autonomousChannelQualified",false},{"agentRealKeyAccess",false}};
    }
    sealed class Fake : IChannelProvider {
        internal int Calls; internal bool Stop,Crash;
        public Dictionary<string,object> Call(string op) {
            Calls++;
            if(Crash) throw new Exception("SYNTHETIC_SECRET_NEVER_EXPORT");
            if(op=="status") return Status();
            return new Dictionary<string,object>{{"status",Stop?"STOP":"READ_CONFIRMED"}};
        }
    }
    static string Temp(string parent) { string p=Path.Combine(parent,Guid.NewGuid().ToString("N"));Directory.CreateDirectory(p);return p; }
    static void Requests() {
        foreach(string op in new[]{"status","observe","reconcile"}) Check(Parsed(op).Operation==op,"allowed op");
        foreach(string op in new[]{"backup","deploy","status;whoami","../observe","OBSERVE"}) {
            var d=Request(op);Reject(()=>ChannelRequest.Parse(Data.Encode(d),Session,Now),"OPERATION_NOT_ALLOWED");
        }
        foreach(string key in new[]{"command","path","arguments","host","environment"}) {
            var d=Request();d[key]="arbitrary";
            Reject(()=>ChannelRequest.Parse(Data.Encode(d),Session,Now),"UNEXPECTED_FIELDS");
        }
        foreach(string field in new[]{"candidate","taskId","protocol"}) {
            var d=Request();d[field]="other";Reject(()=>ChannelRequest.Parse(Data.Encode(d),Session,Now),"REQUEST_SCOPE");
        }
        var stale=Request();stale["sessionId"]=new string('c',32);Reject(()=>ChannelRequest.Parse(Data.Encode(stale),Session,Now),"STALE_CHANNEL_SESSION");
        foreach(string expiry in new[]{Now.ToString("yyyy-MM-ddTHH:mm:ssZ"),Now.AddMinutes(6).ToString("yyyy-MM-ddTHH:mm:ssZ"),"tomorrow"}) {
            var d=Request();d["expiresUtc"]=expiry;Reject(()=>ChannelRequest.Parse(Data.Encode(d),Session,Now),"REQUEST_EXPIRED_OR_INVALID");
        }
        var invalid=Request();invalid["requestId"]="../escape";Reject(()=>ChannelRequest.Parse(Data.Encode(invalid),Session,Now),"REQUEST_ID_INVALID");
        string duplicate=Data.Encode(Request()).Replace("{","{\"operation\":\"deploy\",");
        Reject(()=>ChannelRequest.Parse(duplicate,Session,Now),"DUPLICATE_OR_INVALID_JSON_KEY");
        Reject(()=>ChannelRequest.Parse(new string('x',2049),Session,Now),"REQUEST_SIZE");
        string rpc=SealedProvider.Input("observe"); Check(!rpc.Contains("backup") && rpc.Contains("fai_crm_m1_observe") && rpc.Split('\n').Length==4,"fixed RPC");
        Reject(()=>SealedProvider.Input("status --command"),"OPERATION_NOT_ALLOWED");
    }
    static void Responses() {
        Check((bool)SealedProvider.Validate(Status(),"status")["installed"],"status validated");
        var d=Status();d["environment"]="SYNTHETIC_SECRET";Reject(()=>SealedProvider.Validate(d,"status"),"UNEXPECTED_FIELDS");
        d=Status();d["agentRealKeyAccess"]=true;Reject(()=>SealedProvider.Validate(d,"status"),"PROVIDER_SAFETY_INVALID");
        d=Status();d["executableSha256"]=new string('0',64);Reject(()=>SealedProvider.Validate(d,"status"),"PROVIDER_STATUS_INVALID");
        d=Status();d["code"]="Raw error: SYNTHETIC_SECRET";Reject(()=>SealedProvider.Validate(d,"status"),"PROVIDER_CODE_INVALID");
        d=new Dictionary<string,object>{{"status","STOP"},{"code","SSH_DNS_FAILED"},{"productionMutationPerformed",false}};
        Check(SealedProvider.Validate(d,"observe").Count==3,"minimal provider stop");
        d["rawError"]="SYNTHETIC_SECRET";Reject(()=>SealedProvider.Validate(d,"observe"),"UNEXPECTED_FIELDS");
        string lines=Data.Encode(new{jsonrpc="2.0",id=1,result=new{protocolVersion="2025-06-18"}})+"\n"+
            Data.Encode(new{jsonrpc="2.0",id=2,result=new{content=new[]{new{type="text",text=Data.Encode(Status())}},isError=false}})+"\n";
        Check((bool)SealedProvider.Parse(new CommandResult{Exit=0,Output=lines,Error=""},"status")["installed"],"actual RPC parser");
        Reject(()=>SealedProvider.Parse(new CommandResult{Exit=0,Output=lines,Error="SYNTHETIC_SECRET"},"status"),"PROVIDER_EXIT_OR_STDERR");
        Reject(()=>SealedProvider.Parse(new CommandResult{Exit=0,Output=lines+"{}\n",Error=""},"status"),"PROVIDER_RESPONSE_COUNT");
        Reject(()=>SealedProvider.Parse(new CommandResult{Exit=0,Output=lines.Replace("\"id\":2","\"id\":3"),Error=""},"status"),"PROVIDER_RPC_ENVELOPE");
    }
    static void StateMachine(string root) {
        string dir=Temp(root);var fake=new Fake();var engine=new ChannelEngine(dir,Session,fake);
        var r=Parsed();engine.Process(r);
        Check(fake.Calls==1 && engine.HasReceipt(r.Id) && !engine.Gated,"first read");
        string file=Path.Combine(dir,"receipt-"+r.Id+".json");string hash=Data.FileSha(file);
        engine.Process(r);Check(fake.Calls==1 && Data.FileSha(file)==hash,"no replay and immutable receipt");
        fake.Stop=true;var stopped=Parsed();engine.Process(stopped);Check(engine.Gated && fake.Calls==2,"stop gates");
        var blocked=Parsed();engine.Process(blocked);Check(fake.Calls==2 && File.ReadAllText(Path.Combine(dir,"receipt-"+blocked.Id+".json")).Contains("RECONCILIATION_REQUIRED"),"no call while gated");
        engine.Process(Parsed("status"));Check(engine.Gated && fake.Calls==3,"status does not clear gate");
        fake.Stop=false;engine.Process(Parsed("reconcile"));Check(!engine.Gated && fake.Calls==4,"reconcile clears gate only on success");
        engine.Process(Parsed());Check(fake.Calls==5,"post reconcile observation");
        // Simulated prior process death: durable pending without a receipt.
        ChannelEngine.WriteNew(Path.Combine(dir,"pending.json"),new{requestId=new string('d',32)});
        var restarted=new ChannelEngine(dir,new string('e',32),fake);
        var next=Parsed();next.Session=new string('e',32);restarted.Process(next);
        Check(fake.Calls==5 && restarted.Gated,"restart never resumes prior call");
        var rec=Parsed("reconcile");rec.Session=new string('e',32);restarted.Process(rec);
        Check(fake.Calls==6 && !restarted.Gated && Directory.GetFiles(dir,"pending-reconciled-*").Length>=1,"pending retained on reconciliation");
        var duplicate=Parsed();ChannelEngine.WriteNew(Path.Combine(dir,"claim-"+duplicate.Id+".json"),new{requestId=duplicate.Id});
        Reject(()=>engine.Process(duplicate),"CLAIM_WITHOUT_RECEIPT_RECONCILE");
        Check(fake.Calls==6,"incomplete claim cannot run twice");
        fake.Crash=true;var crash=Parsed();engine.Process(crash);
        string receipt=File.ReadAllText(Path.Combine(dir,"receipt-"+crash.Id+".json"));
        Check(!receipt.Contains("SYNTHETIC_SECRET") && receipt.Contains("CHANNEL_OPERATION_FAILED_REDACTED") && engine.Gated,"sanitized exception and preserved gate");
        string dir2=Temp(root);
        using(var first=new FileStream(Path.Combine(dir2,"channel.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)) {
            bool denied=false;try {using(var second=new FileStream(Path.Combine(dir2,"channel.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)) {}}catch(IOException){denied=true;}
            Check(denied,"exclusive cross-process file contract");
        }
    }
    static void Files(string root,bool fixtureBoundary) {
        string dir=Temp(root),file=Path.Combine(dir,"request.json");File.WriteAllText(file,"{}",new UTF8Encoding(false));
        FileLease.Info metadata;IDisposable held;
        if(fixtureBoundary) held=FileLease.Open(dir,true,out metadata);
        else held=FileLease.Directory(dir);
        using(held) {
            Check(FileLease.Read(file,2048)=="{}","handle identity and bounded file read");
            bool denied=false;try{Directory.Move(dir,dir+"-moved");}catch(IOException){denied=true;}
            Check(denied,"leased directory cannot be renamed");
        }
        File.WriteAllText(file,new string('x',2049));Reject(()=>FileLease.Read(file,2048),"CHANNEL_FILE_SIZE");
        File.WriteAllText(file,"{}");string hard=Path.Combine(dir,"hard.json");
        Check(CreateHardLink(hard,file,IntPtr.Zero),"synthetic hardlink created");
        Reject(()=>FileLease.Read(hard,2048),"CHANNEL_HARDLINK_DENIED");
        Reject(()=>FileLease.Read(file,2048),"CHANNEL_HARDLINK_DENIED");
        string locked=Path.Combine(dir,"locked.json");File.WriteAllText(locked,"{}");
        using(var writer=new FileStream(locked,FileMode.Open,FileAccess.Write,FileShare.Read)) {
            Reject(()=>FileLease.Read(locked,2048),"CHANNEL_FILE_OPEN_FAILED");
        }
        string exclusive=Path.Combine(root,"exclusive-"+Guid.NewGuid().ToString("N"));
        byte[] descriptor=Directory.GetAccessControl(root).GetSecurityDescriptorBinaryForm();
        FileChannelInstallSupport.CreateExclusive(exclusive,descriptor);
        string marker=Path.Combine(exclusive,"keep.txt");File.WriteAllText(marker,"synthetic");
        Reject(()=>FileChannelInstallSupport.CreateExclusive(exclusive,descriptor),"CHANNEL_DIRECTORY_CREATION_REFUSED");
        Check(File.ReadAllText(marker)=="synthetic","occupied directory is never altered");
        Reject(()=>FileChannelInstallSupport.CreateProtectedDirectory(exclusive,descriptor),"INSTALL_DIRECTORY_SCOPE");
    }
    public static int Main(string[] args) {
        try {
            string root=Temp(Path.GetTempPath());
            bool fixtureBoundary=args.Length==1 && args[0]=="--fixture-boundary";
            Check(args.Length==0 || fixtureBoundary,"test arguments");
            Requests();Responses();StateMachine(root);Files(root,fixtureBoundary);
            Console.WriteLine(Data.Encode(new{status="FILE_CHANNEL_SYNTHETIC_PASS",assertions=passed,fullAncestorLeaseTested=!fixtureBoundary,
                remoteConnectionAttempted=false,installationPerformed=false,artifacts=root}));return 0;
        } catch(Exception e) { Console.Error.WriteLine(e.GetType().Name+": "+e.Message);return 1; }
    }
}
