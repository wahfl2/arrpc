import ffi from "ffi-napi";
import ref from "ref-napi";
import StructType from "ref-struct-napi";

// https://www.geoffchappell.com/studies/windows/km/ntoskrnl/api/ex/sysinfo/process_id.htm
const SystemProcessIdInformation = 88;

const STATUS_INFO_LENGTH_MISMATCH = 0xC0000004;
const NT_SUCCESS = (status) => status >= 0;
const NT_ERROR = (status) => status < 0;

const BOOL = ref.types.bool;

const DWORD = ref.types.uint32;
const LPDWORD = ref.refType(DWORD);

const USHORT = ref.types.uint16;
const PWSTR = ref.refType(USHORT);

const UNICODE_STRING = StructType({
  'Length': USHORT,
  'MaximumLength': USHORT,
  'Buffer': PWSTR,
});

const SystemInformationType = StructType({
  'ProcessId': ref.types.size_t,
  'ImageName': UNICODE_STRING
});

// Load Windows API
const psapi = ffi.Library('C:/Windows/System32/psapi.dll', {
  // https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-enumprocesses
  'EnumProcesses': [ BOOL, [ LPDWORD, DWORD, LPDWORD ] ]
});

const kernel32 = ffi.Library('C:/Windows/System32/kernel32.dll', {
  // https://learn.microsoft.com/en-us/windows/win32/api/errhandlingapi/nf-errhandlingapi-getlasterror
  'GetLastError': [ DWORD, [] ]
});

const ntdll = ffi.Library('C:/Windows/System32/ntdll.dll', {
  'NtQuerySystemInformation': [ DWORD, [ DWORD, SystemInformationType, DWORD, LPDWORD ] ]
});

/**
 * https://learn.microsoft.com/en-us/windows/win32/api/errhandlingapi/nf-errhandlingapi-getlasterror
 * @returns {number} the calling thread's last error code value
 */
const GetLastError = () => kernel32.GetLastError();

/**
 * https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-enumprocesses
 * @returns {?number[]} an array of all PIDs with active processes
 * @returns null if EnumProcesses fails
 */
const EnumProcesses = () => {
  const processIdsBuf = Buffer.alloc(1024 * 4);
  const bytesNeeded = Buffer.alloc(1 * 4);

  const success = psapi.EnumProcesses(processIdsBuf, processIdsBuf.byteLength, bytesNeeded);

  if (!success) {
    console.log(`EnumProcesses failed with error code ${GetLastError()}`);
    return null;
  }

  let processIds = [];
  const numProcesses = bytesNeeded.readUInt32LE(0) / 4;
  for (let i = 0; i < numProcesses; i++) {
    processIds.push(processIdsBuf.readUint32LE(i * 4))
  }

  return processIds;
};

/**
 * Calls [NtQuerySystemInformation](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntquerysysteminformation)
 * with a SystemInformationClass of [SYSTEM_PROCESS_ID_INFORMATION](https://www.geoffchappell.com/studies/windows/km/ntoskrnl/api/ex/sysinfo/process_id.htm)
 * and the provided PID.
 * @param {number} pid The PID of the process whose executable path you want to query
 * @returns {?string} the executable path of the process
 * @returns null if NtQuerySystemInformation fails
 */
const QueryProcessImageName = (pid) => {
  let bufferSize = 1024;
  let buffer = Buffer.alloc(bufferSize);

  while (true) {
    let info = new SystemInformationType({
      ProcessId: pid,
      ImageName: new UNICODE_STRING({
        Length: 0,
        MaximumLength: buffer.length, 
        Buffer: buffer
      })
    });

    const status = ntdll.NtQuerySystemInformation(SystemProcessIdInformation, info.ref(), 24, null);
  
    if (NT_ERROR(status) && status !== STATUS_INFO_LENGTH_MISMATCH) {
      console.error(`NtQuerySystemInformation() failed with pid = ${pid}, error code ${status}`);
      return null;
    }
  
    if (NT_SUCCESS(status)) {
      return buffer.subarray(0, info.ImageName.Buffer.length).toString('utf16le');
    }
  
    if (bufferSize >= 0xffff) {
      console.error(`NtQuerySystemInformation() failed with pid = ${pid}, result could not fit in buffer of size 0xffff`);
      return null;
    }

    bufferSize *= 2;
    if (bufferSize > 0xffff) bufferSize = 0xffff;
    buffer = Buffer.alloc(bufferSize);
  }
}

export const getProcesses = () => new Promise(res =>  {
  let out = []
  const pids = EnumProcesses()

  if (pids) {
    for (const pid of pids) {
      let imageName = QueryProcessImageName(pid);
      if (imageName != null) {
        out.push([pid, imageName])
      }
    }
  }

  res(out)
});