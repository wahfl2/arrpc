import { arrayConstructor, createPointer, DataType, FFITypeTag, freePointer, load, open, restorePointer, unwrapPointer } from 'ffi-rs'

// https://www.geoffchappell.com/studies/windows/km/ntoskrnl/api/ex/sysinfo/process_id.htm
const SystemProcessIdInformation = 88;

const STATUS_INFO_LENGTH_MISMATCH = 0xC0000004;
const NT_SUCCESS = (status) => status >= 0;
const NT_ERROR = (status) => status < 0;

const UNICODE_STRING = {
  Length: DataType.I16,
  MaximumLength: DataType.I16,
  Buffer: arrayConstructor({
    type: DataType.U8Array,
    length: 0xffff
  })
}

const SystemInfoType = {
  ProcessId: DataType.I32,
  ImageName: UNICODE_STRING
};

// Load Windows API
open({ library: 'psapi', path: 'psapi.dll' });
open({ library: 'kernel32', path: 'kernel32.dll' });
open({ library: 'ntdll', path: 'ntdll.dll' });

/**
 * https://learn.microsoft.com/en-us/windows/win32/api/errhandlingapi/nf-errhandlingapi-getlasterror
 * @returns {number} the calling thread's last error code value
 */
const GetLastError = () => load({
  library: 'kernel32',
  funcName: 'GetLastError',
  retType: DataType.I32,
  paramsType: [],
  paramsValue: []
});

/**
 * https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-enumprocesses
 * @returns {?number[]} an array of all PIDs with active processes
 * @returns null if EnumProcesses fails
 */
const EnumProcesses = () => {
  const processIdsBuf = Buffer.alloc(1024 * 4);
  const bytesNeeded = Buffer.alloc(1 * 4);

  const success = load({
    library: 'psapi',
    funcName: 'EnumProcesses',
    retType: DataType.Boolean,
    paramsType: [DataType.U8Array, DataType.I32, DataType.U8Array],
    paramsValue: [processIdsBuf, processIdsBuf.byteLength, bytesNeeded]
  });

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

  let info = {
    ProcessId: pid,
    ImageName: {
      Length: 0,
      MaximumLength: buffer.length,
      Buffer: buffer
    }
  };

  while (true) {
    // shits fucked idk
    const ptr = createPointer({
      paramsType: [SystemInfoType],
      paramsValue: [info]
    });

    const status = load({
      library: 'ntdll',
      funcName: 'NtQuerySystemInformation',
      retType: DataType.I32,
      paramsType: [DataType.I32, DataType.External, DataType.I32, DataType.Void],
      paramsValue: [SystemProcessIdInformation, unwrapPointer(ptr)[0], 24, null]
    });

    info = restorePointer({
      retType: [SystemInfoType],
      paramsValue: ptr
    });
  
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
