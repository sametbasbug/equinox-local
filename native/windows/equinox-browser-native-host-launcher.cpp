#define UNICODE
#define _UNICODE
#include <windows.h>

#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {

std::wstring parentPath(const std::wstring& value) {
  const auto offset = value.find_last_of(L"\\/");
  if (offset == std::wstring::npos || offset == 0) return L"";
  return value.substr(0, offset);
}

bool isNormalFile(const std::wstring& value) {
  const DWORD attributes = GetFileAttributesW(value.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

std::wstring quoteArgument(const std::wstring& value) {
  if (!value.empty() && value.find_first_of(L" \t\n\v\"") == std::wstring::npos) return value;
  std::wstring out = L"\"";
  std::size_t slashes = 0;
  for (const wchar_t ch : value) {
    if (ch == L'\\') {
      ++slashes;
      continue;
    }
    if (ch == L'\"') {
      out.append(slashes * 2 + 1, L'\\');
      out.push_back(L'\"');
      slashes = 0;
      continue;
    }
    out.append(slashes, L'\\');
    slashes = 0;
    out.push_back(ch);
  }
  out.append(slashes * 2, L'\\');
  out.push_back(L'\"');
  return out;
}

std::wstring buildCommandLine(const std::wstring& nodePath, const std::wstring& hostScript, int argc, wchar_t** argv) {
  std::wstring command = quoteArgument(nodePath) + L" " + quoteArgument(hostScript);
  for (int index = 1; index < argc; ++index) {
    command.push_back(L' ');
    command += quoteArgument(argv[index] == nullptr ? L"" : std::wstring(argv[index]));
  }
  if (command.size() >= 32760) return L"";
  return command;
}

HANDLE duplicateStandardHandle(DWORD standardHandle, DWORD fallbackAccess) {
  HANDLE source = GetStdHandle(standardHandle);
  if (source != nullptr && source != INVALID_HANDLE_VALUE) {
    HANDLE duplicate = nullptr;
    if (DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &duplicate, 0, TRUE, DUPLICATE_SAME_ACCESS)) {
      return duplicate;
    }
  }
  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.bInheritHandle = TRUE;
  return CreateFileW(L"NUL", fallbackAccess, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
}

void closeHandleIfValid(HANDLE handle) {
  if (handle != nullptr && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
}

int fail(const wchar_t* message, DWORD code = 0) {
  std::wcerr << L"Equinox Browser native host launcher: " << message;
  if (code != 0) std::wcerr << L" (Windows error " << code << L")";
  std::wcerr << std::endl;
  return 70;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  std::vector<wchar_t> moduleBuffer(32768, L'\0');
  const DWORD moduleLength = GetModuleFileNameW(nullptr, moduleBuffer.data(), static_cast<DWORD>(moduleBuffer.size()));
  if (moduleLength == 0 || moduleLength >= moduleBuffer.size()) return fail(L"could not resolve launcher path", GetLastError());

  const std::wstring launcherPath(moduleBuffer.data(), moduleLength);
  const std::wstring browserDir = parentPath(launcherPath);
  const std::wstring runtimeDir = parentPath(browserDir);
  const std::wstring releaseDir = parentPath(runtimeDir);
  if (browserDir.empty() || runtimeDir.empty() || releaseDir.empty()) return fail(L"release-local path layout is invalid");

  const std::wstring nodePath = runtimeDir + L"\\node\\bin\\node.exe";
  const std::wstring hostScript = releaseDir + L"\\equinox-browser-native-host.js";
  if (!isNormalFile(nodePath)) return fail(L"release-local node.exe is missing");
  if (!isNormalFile(hostScript)) return fail(L"release-local native host script is missing");

  std::wstring commandLine = buildCommandLine(nodePath, hostScript, argc, argv);
  if (commandLine.empty()) return fail(L"child command line is too long");
  std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
  mutableCommand.push_back(L'\0');

  HANDLE childIn = duplicateStandardHandle(STD_INPUT_HANDLE, GENERIC_READ);
  HANDLE childOut = duplicateStandardHandle(STD_OUTPUT_HANDLE, GENERIC_WRITE);
  HANDLE childErr = duplicateStandardHandle(STD_ERROR_HANDLE, GENERIC_WRITE);
  if (childIn == INVALID_HANDLE_VALUE || childOut == INVALID_HANDLE_VALUE || childErr == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    closeHandleIfValid(childIn);
    closeHandleIfValid(childOut);
    closeHandleIfValid(childErr);
    return fail(L"could not prepare inherited stdio", error);
  }

  HANDLE inheritedHandles[] = { childIn, childOut, childErr };
  SIZE_T attributeBytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
  std::vector<std::uint8_t> attributeStorage(attributeBytes);
  auto* attributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
  if (!InitializeProcThreadAttributeList(attributeList, 1, 0, &attributeBytes)) {
    const DWORD error = GetLastError();
    closeHandleIfValid(childIn); closeHandleIfValid(childOut); closeHandleIfValid(childErr);
    return fail(L"could not initialize inherited-handle allowlist", error);
  }
  if (!UpdateProcThreadAttribute(
        attributeList,
        0,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inheritedHandles,
        sizeof(inheritedHandles),
        nullptr,
        nullptr)) {
    const DWORD error = GetLastError();
    DeleteProcThreadAttributeList(attributeList);
    closeHandleIfValid(childIn); closeHandleIfValid(childOut); closeHandleIfValid(childErr);
    return fail(L"could not configure inherited-handle allowlist", error);
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = childIn;
  startup.StartupInfo.hStdOutput = childOut;
  startup.StartupInfo.hStdError = childErr;
  startup.lpAttributeList = attributeList;
  PROCESS_INFORMATION process{};

  const BOOL started = CreateProcessW(
    nodePath.c_str(),
    mutableCommand.data(),
    nullptr,
    nullptr,
    TRUE,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
    nullptr,
    releaseDir.c_str(),
    &startup.StartupInfo,
    &process);
  const DWORD startError = started ? ERROR_SUCCESS : GetLastError();

  DeleteProcThreadAttributeList(attributeList);
  closeHandleIfValid(childIn);
  closeHandleIfValid(childOut);
  closeHandleIfValid(childErr);

  if (!started) return fail(L"could not start release-local Node host", startError);
  CloseHandle(process.hThread);

  const DWORD waitResult = WaitForSingleObject(process.hProcess, INFINITE);
  if (waitResult != WAIT_OBJECT_0) {
    const DWORD error = GetLastError();
    CloseHandle(process.hProcess);
    return fail(L"failed while waiting for native host", error);
  }

  DWORD exitCode = 1;
  if (!GetExitCodeProcess(process.hProcess, &exitCode)) {
    const DWORD error = GetLastError();
    CloseHandle(process.hProcess);
    return fail(L"could not read native host exit status", error);
  }
  CloseHandle(process.hProcess);
  return static_cast<int>(exitCode);
}
