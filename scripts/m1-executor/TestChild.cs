// Synthetic process fixtures. This source is NEVER in the installed binary.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
internal static class TestChild {
    public static int Main(string[] args) {
        if(args[0]=="echo") { Console.Write(Console.In.ReadToEnd()); return 0; }
        if(args[0]=="overflow") { Console.Write(new string('x',200000)); Thread.Sleep(30000); return 0; }
        if(args[0]=="sleep") { Thread.Sleep(30000); return 0; }
        if(args[0]=="descendant") {
            var child=Process.Start(new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location,"sleep") {UseShellExecute=false,CreateNoWindow=true});
            File.WriteAllText(args[1],child.Id.ToString()); Thread.Sleep(30000); return 0;
        }
        return 2;
    }
}
