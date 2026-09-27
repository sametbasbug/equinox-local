$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class EquinoxJobObjectNative {
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_SET_QUOTA = 0x0100;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr hJob, int infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength, IntPtr lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void ThrowLast(string operation) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    public static IntPtr CreateKillOnCloseJob() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) ThrowLast("CreateJobObject");

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(info, buffer, false);
            if (!SetInformationJobObject(job, 9, buffer, (uint)size)) {
                int error = Marshal.GetLastWin32Error();
                CloseHandle(job);
                throw new Win32Exception(error, "SetInformationJobObject failed");
            }
        } finally {
            Marshal.FreeHGlobal(buffer);
        }
        return job;
    }

    public static void Assign(IntPtr job, uint processId) {
        IntPtr process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) ThrowLast("OpenProcess");
        try {
            if (!AssignProcessToJobObject(job, process)) ThrowLast("AssignProcessToJobObject");
        } finally {
            CloseHandle(process);
        }
    }

    public static uint ActiveProcesses(IntPtr job) {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            if (!QueryInformationJobObject(job, 1, buffer, (uint)size, IntPtr.Zero)) ThrowLast("QueryInformationJobObject");
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return info.ActiveProcesses;
        } finally {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static void Terminate(IntPtr job, uint exitCode) {
        if (!TerminateJobObject(job, exitCode)) ThrowLast("TerminateJobObject");
    }

    public static void Close(IntPtr job) {
        if (job != IntPtr.Zero && !CloseHandle(job)) ThrowLast("CloseHandle");
    }
}
'@

function Send-Reply([object]$value) {
    [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
}

$job = [IntPtr]::Zero
try {
    $job = [EquinoxJobObjectNative]::CreateKillOnCloseJob()
    Send-Reply @{ ok = $true; ready = $true }

    while (($line = [Console]::In.ReadLine()) -ne $null) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $request = $null
        try {
            $request = $line | ConvertFrom-Json
            $requestId = [string]$request.id
            switch ([string]$request.op) {
                'assign' {
                    $pidValue = [uint32]$request.pid
                    if ($pidValue -eq 0) { throw 'assign requires a positive pid' }
                    [EquinoxJobObjectNative]::Assign($job, $pidValue)
                    Send-Reply @{ ok = $true; id = $requestId; activeProcesses = [EquinoxJobObjectNative]::ActiveProcesses($job) }
                }
                'status' {
                    Send-Reply @{ ok = $true; id = $requestId; activeProcesses = [EquinoxJobObjectNative]::ActiveProcesses($job) }
                }
                'terminate' {
                    $exitCode = [uint32]$request.exitCode
                    [EquinoxJobObjectNative]::Terminate($job, $exitCode)
                    Send-Reply @{ ok = $true; id = $requestId; activeProcesses = [EquinoxJobObjectNative]::ActiveProcesses($job) }
                }
                'close' {
                    [EquinoxJobObjectNative]::Close($job)
                    $job = [IntPtr]::Zero
                    Send-Reply @{ ok = $true; id = $requestId; closed = $true }
                    break
                }
                default { throw 'unsupported job-object operation' }
            }
            if ([string]$request.op -eq 'close') { break }
        } catch {
            $requestId = if ($null -ne $request) { [string]$request.id } else { '' }
            Send-Reply @{ ok = $false; id = $requestId; error = $_.Exception.Message }
        }
    }
} finally {
    if ($job -ne [IntPtr]::Zero) {
        try { [EquinoxJobObjectNative]::Close($job) } catch {}
    }
}
