#include <windows.h>
#include <shlobj.h>

#pragma comment(lib, "Advapi32.lib")
#pragma comment(lib, "Shell32.lib")
#pragma comment(lib, "Ole32.lib")

#include <cstdint>
#include <cwchar>
#include <cwctype>
#include <vector>
#include <limits>
#include <iostream>
#include <sstream>
#include <string>

namespace {
constexpr DWORD kKillOnJobClose = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
constexpr uint64_t kWindowsFileTimeToDotNetTicks = 504911232000000000ULL;

std::wstring ReadEnvironment(const wchar_t* name) {
  const DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
  if (size < 2 || size > 32767) return {};
  std::wstring value(size, L'\0');
  const DWORD copied = GetEnvironmentVariableW(name, value.data(), size);
  if (copied == 0 || copied >= size) return {};
  value.resize(copied);
  return value;
}

// One-shot OS identity query for the already-validated native Main update
// candidate. This mode must not start a Job Object or require PowerShell.
int InspectWorkerProcess() {
  const auto pidText = ReadEnvironment(L"EQUINOX_LOCAL_CHECK_WORKER_PID");
  const auto ticks = ReadEnvironment(L"EQUINOX_LOCAL_CHECK_WORKER_TICKS");
  const auto expectedNode = ReadEnvironment(L"EQUINOX_LOCAL_CHECK_WORKER_NODE");
  uint64_t parsedPid = 0;
  try {
    if (pidText.empty() || pidText.find_first_not_of(L"0123456789") != std::wstring::npos ||
        ticks.empty() || ticks.find_first_not_of(L"0123456789") != std::wstring::npos ||
        expectedNode.empty()) {
      std::cout << "unknown";
      return 0;
    }
    parsedPid = std::stoull(pidText);
  } catch (...) {
    std::cout << "unknown";
    return 0;
  }
  if (parsedPid == 0 || parsedPid > (std::numeric_limits<DWORD>::max)()) {
    std::cout << "unknown";
    return 0;
  }
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(parsedPid));
  if (!process) {
    std::cout << (GetLastError() == ERROR_INVALID_PARAMETER ? "missing" : "unknown");
    return 0;
  }
  FILETIME creation{}, exit{}, kernel{}, user{};
  DWORD pathChars = 32768;
  std::wstring executable(pathChars, L'\0');
  const BOOL gotTime = GetProcessTimes(process, &creation, &exit, &kernel, &user);
  const BOOL gotPath = gotTime ? QueryFullProcessImageNameW(process, 0, executable.data(), &pathChars) : FALSE;
  CloseHandle(process);
  if (!gotTime || !gotPath) {
    std::cout << "unknown";
    return 0;
  }
  executable.resize(pathChars);
  const uint64_t fileTicks = (static_cast<uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
  if (fileTicks > (std::numeric_limits<uint64_t>::max)() - kWindowsFileTimeToDotNetTicks ||
      std::to_wstring(fileTicks + kWindowsFileTimeToDotNetTicks) != ticks ||
      CompareStringOrdinal(executable.data(), static_cast<int>(executable.size()),
                           expectedNode.data(), static_cast<int>(expectedNode.size()), TRUE) != CSTR_EQUAL) {
    std::cout << "mismatch";
    return 0;
  }
  std::cout << "running";
  return 0;
}

// This read-only OS witness is a building block for a separately owned
// native A/B supervisor. It cannot stop WPF, authorize a journal transition,
// return a bearer token, or make an in-process Node callback a native owner.
// The expected executable comes from the OS per-user known folder, NOT a
// worker-supplied path/environment variable.
bool SameWindowsLogon(HANDLE process) {
  HANDLE shellToken = nullptr;
  HANDLE witnessToken = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &shellToken)) return false;
  const BOOL ownToken = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &witnessToken);
  if (!ownToken) { CloseHandle(shellToken); return false; }
  auto close = [&]() { CloseHandle(shellToken); CloseHandle(witnessToken); };
  TOKEN_STATISTICS shellStats{}, witnessStats{};
  DWORD bytes = 0;
  if (!GetTokenInformation(shellToken, TokenStatistics, &shellStats, sizeof(shellStats), &bytes) ||
      !GetTokenInformation(witnessToken, TokenStatistics, &witnessStats, sizeof(witnessStats), &bytes)) {
    close(); return false;
  }
  if (shellStats.AuthenticationId.LowPart != witnessStats.AuthenticationId.LowPart ||
      shellStats.AuthenticationId.HighPart != witnessStats.AuthenticationId.HighPart) {
    close(); return false;
  }
  DWORD shellBytes = 0, witnessBytes = 0;
  GetTokenInformation(shellToken, TokenUser, nullptr, 0, &shellBytes);
  GetTokenInformation(witnessToken, TokenUser, nullptr, 0, &witnessBytes);
  if (shellBytes < sizeof(TOKEN_USER) || witnessBytes < sizeof(TOKEN_USER) ||
      shellBytes > 16 * 1024 || witnessBytes > 16 * 1024) {
    close(); return false;
  }
  std::vector<BYTE> shellUser(shellBytes), witnessUser(witnessBytes);
  const bool valid = GetTokenInformation(shellToken, TokenUser, shellUser.data(), shellBytes, &shellBytes) &&
    GetTokenInformation(witnessToken, TokenUser, witnessUser.data(), witnessBytes, &witnessBytes) &&
    EqualSid(reinterpret_cast<TOKEN_USER*>(shellUser.data())->User.Sid,
             reinterpret_cast<TOKEN_USER*>(witnessUser.data())->User.Sid);
  close();
  return valid;
}

int InspectOwnedWpfProcess() {
  const auto pidText = ReadEnvironment(L"EQUINOX_LOCAL_CHECK_WPF_PID");
  const auto ticks = ReadEnvironment(L"EQUINOX_LOCAL_CHECK_WPF_TICKS");
  uint64_t parsedPid = 0;
  try {
    if (pidText.empty() || pidText.find_first_not_of(L"0123456789") != std::wstring::npos ||
        ticks.size() < 15 || ticks.size() > 19 ||
        ticks.find_first_not_of(L"0123456789") != std::wstring::npos) {
      std::cout << "unknown"; return 0;
    }
    parsedPid = std::stoull(pidText);
  } catch (...) { std::cout << "unknown"; return 0; }
  if (parsedPid == 0 || parsedPid > (std::numeric_limits<DWORD>::max)()) {
    std::cout << "unknown"; return 0;
  }
  PWSTR userLocal = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr, &userLocal)) || !userLocal) {
    if (userLocal) CoTaskMemFree(userLocal);
    std::cout << "unknown"; return 0;
  }
  const std::wstring expectedExe = std::wstring(userLocal) + L"\\Programs\\Equinox Local\\EquinoxLocal.exe";
  CoTaskMemFree(userLocal);
  // WaitForSingleObject requires SYNCHRONIZE on the process handle.
  // Do not request PROCESS_TERMINATE, PROCESS_VM_READ or broader access.
  HANDLE shell = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, static_cast<DWORD>(parsedPid));
  if (!shell) {
    std::cout << (GetLastError() == ERROR_INVALID_PARAMETER ? "missing" : "unknown"); return 0;
  }
  const auto finish = [&](const char* status) { CloseHandle(shell); std::cout << status; return 0; };
  const DWORD firstWait = WaitForSingleObject(shell, 0);
  if (firstWait == WAIT_OBJECT_0) return finish("missing");
  if (firstWait != WAIT_TIMEOUT) return finish("unknown");
  FILETIME creation{}, exit{}, kernel{}, user{};
  DWORD size = 32768;
  std::wstring executable(size, L'\0');
  if (!GetProcessTimes(shell, &creation, &exit, &kernel, &user) ||
      !QueryFullProcessImageNameW(shell, 0, executable.data(), &size)) return finish("unknown");
  executable.resize(size);
  const uint64_t fileTicks = (static_cast<uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
  DWORD shellSession = 0, ownSession = 0;
  if (!ProcessIdToSessionId(static_cast<DWORD>(parsedPid), &shellSession) ||
      !ProcessIdToSessionId(GetCurrentProcessId(), &ownSession)) return finish("unknown");
  if (fileTicks > (std::numeric_limits<uint64_t>::max)() - kWindowsFileTimeToDotNetTicks ||
      std::to_wstring(fileTicks + kWindowsFileTimeToDotNetTicks) != ticks ||
      shellSession != ownSession ||
      CompareStringOrdinal(executable.data(), static_cast<int>(executable.size()),
                           expectedExe.data(), static_cast<int>(expectedExe.size()), TRUE) != CSTR_EQUAL ||
      !SameWindowsLogon(shell)) return finish("mismatch");
  const DWORD finalWait = WaitForSingleObject(shell, 0);
  return finish(finalWait == WAIT_TIMEOUT ? "running" : finalWait == WAIT_OBJECT_0 ? "missing" : "unknown");
}

std::string EscapeJson(const std::string& value) {
  std::ostringstream out;
  for (unsigned char ch : value) {
    switch (ch) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (ch < 0x20) out << '?';
        else out << ch;
    }
  }
  return out.str();
}

std::string StringField(const std::string& json, const char* name) {
  const std::string key = std::string("\"") + name + "\"";
  auto pos = json.find(key);
  if (pos == std::string::npos) return {};
  pos = json.find(':', pos + key.size());
  if (pos == std::string::npos) return {};
  pos = json.find('"', pos + 1);
  if (pos == std::string::npos) return {};
  ++pos;
  std::string result;
  bool escaped = false;
  for (; pos < json.size(); ++pos) {
    const char ch = json[pos];
    if (escaped) {
      result.push_back(ch);
      escaped = false;
    } else if (ch == '\\') {
      escaped = true;
    } else if (ch == '"') {
      return result;
    } else {
      result.push_back(ch);
    }
  }
  return {};
}

bool UintField(const std::string& json, const char* name, uint32_t* value) {
  const std::string key = std::string("\"") + name + "\"";
  auto pos = json.find(key);
  if (pos == std::string::npos) return false;
  pos = json.find(':', pos + key.size());
  if (pos == std::string::npos) return false;
  ++pos;
  while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) ++pos;
  uint64_t parsed = 0;
  bool any = false;
  while (pos < json.size() && json[pos] >= '0' && json[pos] <= '9') {
    any = true;
    parsed = parsed * 10 + static_cast<unsigned>(json[pos] - '0');
    if (parsed > 0xffffffffULL) return false;
    ++pos;
  }
  if (!any) return false;
  *value = static_cast<uint32_t>(parsed);
  return true;
}

void Reply(const std::string& json) {
  std::cout << json << '\n';
  std::cout.flush();
}

std::string ErrorText(const char* operation, DWORD code) {
  std::ostringstream out;
  out << operation << " failed with Win32 error " << code << ".";
  return out.str();
}

bool QueryActiveProcesses(HANDLE job, DWORD* active, std::string* error) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, sizeof(info), nullptr)) {
    *error = ErrorText("QueryInformationJobObject", GetLastError());
    return false;
  }
  *active = info.ActiveProcesses;
  return true;
}

void ErrorReply(const std::string& id, const std::string& error) {
  Reply("{\"ok\":false,\"id\":\"" + EscapeJson(id) + "\",\"error\":\"" + EscapeJson(error) + "\"}");
}

void SuccessReply(const std::string& id, DWORD active) {
  Reply("{\"ok\":true,\"id\":\"" + EscapeJson(id) + "\",\"activeProcesses\":" + std::to_string(active) + "}");
}

std::wstring QuoteWindowsArg(const std::wstring& value) {
  if (!value.empty() && value.find_first_of(L" \t\n\v\"") == std::wstring::npos) return value;
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t ch : value) {
    if (ch == L'\\') { ++slashes; continue; }
    if (ch == L'"') { result.append(slashes * 2 + 1, L'\\'); result.push_back(ch); slashes = 0; continue; }
    result.append(slashes, L'\\');
    slashes = 0;
    result.push_back(ch);
  }
  result.append(slashes * 2, L'\\');
  result.push_back(L'"');
  return result;
}

std::wstring ResolveGateCommand(const std::wstring& input) {
  if (input.empty() || input.find_first_of(L"\r\n\"") != std::wstring::npos) return {};
  for (const wchar_t* ext : { L"", L".exe", L".cmd", L".bat", L".com" }) {
    std::wstring result(32768, L'\0');
    DWORD length = SearchPathW(nullptr, input.c_str(), *ext ? ext : nullptr,
                               static_cast<DWORD>(result.size()), result.data(), nullptr);
    if (length && length < result.size()) {
      result.resize(length);
      DWORD attributes = GetFileAttributesW(result.c_str());
      if (attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY)) return result;
    }
  }
  return {};
}

// On Windows 11 24H2+ the OS can allocate a real inheritable console with
// NO WINDOW. This avoids Windows Terminal's visible delegation for descendants
// of GUI services, while allowing Windows PowerShell 5.1's native dispatcher
// to inherit a console. Keep the existing redirected stdio handles intact.
bool EnsureInheritedWindowlessConsole() {
  if (GetConsoleWindow() != nullptr) return true;
  const HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
  if (!kernel) return false;
  struct Options {
    DWORD mode;
    BOOL useShowWindow;
    WORD showWindow;
  };
  using Allocate = HRESULT (WINAPI*)(const Options*, DWORD*);
  const auto allocate = reinterpret_cast<Allocate>(
      GetProcAddress(kernel, "AllocConsoleWithOptions"));
  if (!allocate) return false;  // Old Windows: use previous CREATE_NO_WINDOW path.
  const HANDLE saved[3] = {
    GetStdHandle(STD_INPUT_HANDLE),
    GetStdHandle(STD_OUTPUT_HANDLE),
    GetStdHandle(STD_ERROR_HANDLE)
  };
  const Options options{2, FALSE, 0};  // ALLOC_CONSOLE_MODE_NO_WINDOW
  DWORD result = 0;
  const HRESULT hr = allocate(&options, &result);
  for (DWORD i = 0; i < 3; ++i) {
    const DWORD kind = i == 0 ? STD_INPUT_HANDLE
                     : i == 1 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE;
    if (saved[i] && saved[i] != INVALID_HANDLE_VALUE) {
      SetStdHandle(kind, saved[i]);
    }
  }
  return SUCCEEDED(hr) && (result == 1 || result == 2);
}

// The GUI-subsystem helper is assigned to the Job Object before it receives GO.
// A child created here cannot escape the owned job and needs no console window.
int RunOwnedProcessGate(int argc, wchar_t* argv[]) {
  if (argc < 3) return 127;
  std::string signal;
  if (!std::getline(std::cin, signal) || signal != "EQUINOX_GO") return 125;
  std::wstring command = ResolveGateCommand(argv[2]);
  if (command.empty()) { std::cerr << "Native gate executable not found.\n"; return 127; }
  auto dot = command.find_last_of(L'.');
  std::wstring extension = dot == std::wstring::npos ? L"" : command.substr(dot);
  for (auto& ch : extension) ch = static_cast<wchar_t>(towlower(ch));
  const bool batch = extension == L".cmd" || extension == L".bat";
  std::wstring line;
  if (batch) {
    for (int i = 2; i < argc; ++i) {
      if (std::wstring(argv[i]).find_first_of(L"\r\n\"%!^") != std::wstring::npos) {
        std::cerr << "Windows batch argument contains unsupported CMD expansion or quoting characters.\n";
        return 127;
      }
    }
    wchar_t systemDir[MAX_PATH]{};
    const UINT length = GetSystemDirectoryW(systemDir, MAX_PATH);
    if (!length || length >= MAX_PATH) return 127;
    const std::wstring shell = std::wstring(systemDir) + L"\\cmd.exe";
    line = QuoteWindowsArg(shell) + L" /d /v:off /s /c \"\"" + command + L"\"";
    for (int i = 3; i < argc; ++i) line += L" \"" + std::wstring(argv[i]) + L"\"";
    line += L"\"";
  } else {
    line = QuoteWindowsArg(command);
    for (int i = 3; i < argc; ++i) line += L" " + QuoteWindowsArg(argv[i]);
  }

  HANDLE current = GetCurrentProcess();
  HANDLE streams[2]{};
  HANDLE inherited[2] = { GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE) };
  for (int i = 0; i < 2; ++i) {
    if (!inherited[i] || inherited[i] == INVALID_HANDLE_VALUE ||
        !DuplicateHandle(current, inherited[i], current, &streams[i], 0, TRUE, DUPLICATE_SAME_ACCESS)) {
      std::cerr << "Native gate pipe inheritance failed.\n";
      for (HANDLE handle : streams) if (handle) CloseHandle(handle);
      return 127;
    }
  }
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                             &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (input == INVALID_HANDLE_VALUE) {
    std::cerr << "Native gate cannot open stdin.\n";
    for (HANDLE handle : streams) if (handle) CloseHandle(handle);
    return 127;
  }
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  startup.hStdInput = input;
  startup.hStdOutput = streams[0];
  startup.hStdError = streams[1];
  // A child of the new windowless console inherits its console session.
  // CREATE_NO_WINDOW would explicitly detach it and break native PS5 calls.
  // Unsupported Windows builds retain the previous no-window fallback.
  const DWORD creationFlags = EnsureInheritedWindowlessConsole() ? 0 : CREATE_NO_WINDOW;
  PROCESS_INFORMATION child{};
  const BOOL created = CreateProcessW(nullptr, line.data(), nullptr, nullptr, TRUE,
                                      creationFlags, nullptr, nullptr, &startup, &child);
  DWORD createError = created ? ERROR_SUCCESS : GetLastError();
  CloseHandle(input);
  for (HANDLE handle : streams) CloseHandle(handle);
  if (!created) {
    std::cerr << ErrorText("CreateProcessW", createError) << "\n";
    return 127;
  }
  CloseHandle(child.hThread);
  DWORD exitCode = 127;
  const DWORD waited = WaitForSingleObject(child.hProcess, INFINITE);
  if (waited != WAIT_OBJECT_0 || !GetExitCodeProcess(child.hProcess, &exitCode)) {
    std::cerr << "Native gate wait failed.\n";
    exitCode = 127;
  }
  CloseHandle(child.hProcess);
  return static_cast<int>(exitCode);
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc == 2 && std::wstring(argv[1]) == L"--inspect-process") return InspectWorkerProcess();
  if (argc == 2 && std::wstring(argv[1]) == L"--inspect-owned-wpf") return InspectOwnedWpfProcess();
  if (argc >= 2 && std::wstring(argv[1]) == L"--owned-process-gate") return RunOwnedProcessGate(argc, argv);
  if (argc != 1) return 12;
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) {
    std::cerr << ErrorText("CreateJobObject", GetLastError()) << std::endl;
    return 10;
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = kKillOnJobClose;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    std::cerr << ErrorText("SetInformationJobObject", GetLastError()) << std::endl;
    CloseHandle(job);
    return 11;
  }

  Reply("{\"ok\":true,\"ready\":true}");
  std::string line;
  while (std::getline(std::cin, line)) {
    const std::string id = StringField(line, "id");
    const std::string op = StringField(line, "op");
    if (id.empty() || op.empty()) {
      ErrorReply(id, "invalid job-object request");
      continue;
    }

    if (op == "assign") {
      uint32_t pid = 0;
      if (!UintField(line, "pid", &pid) || pid == 0) {
        ErrorReply(id, "assign requires a positive pid");
        continue;
      }
      HANDLE process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
                                   FALSE, pid);
      if (!process) {
        ErrorReply(id, ErrorText("OpenProcess", GetLastError()));
        continue;
      }
      const BOOL assigned = AssignProcessToJobObject(job, process);
      const DWORD assignError = assigned ? ERROR_SUCCESS : GetLastError();
      CloseHandle(process);
      if (!assigned) {
        ErrorReply(id, ErrorText("AssignProcessToJobObject", assignError));
        continue;
      }
      DWORD active = 0;
      std::string error;
      if (!QueryActiveProcesses(job, &active, &error)) ErrorReply(id, error);
      else SuccessReply(id, active);
      continue;
    }

    if (op == "status") {
      DWORD active = 0;
      std::string error;
      if (!QueryActiveProcesses(job, &active, &error)) ErrorReply(id, error);
      else SuccessReply(id, active);
      continue;
    }

    if (op == "terminate") {
      uint32_t exitCode = 0;
      if (!UintField(line, "exitCode", &exitCode)) {
        ErrorReply(id, "terminate requires an exit code");
        continue;
      }
      if (!TerminateJobObject(job, exitCode)) {
        ErrorReply(id, ErrorText("TerminateJobObject", GetLastError()));
        continue;
      }
      DWORD active = 0;
      std::string error;
      if (!QueryActiveProcesses(job, &active, &error)) ErrorReply(id, error);
      else SuccessReply(id, active);
      continue;
    }

    if (op == "close") {
      CloseHandle(job);
      job = nullptr;
      Reply("{\"ok\":true,\"id\":\"" + EscapeJson(id) + "\",\"closed\":true}");
      return 0;
    }

    ErrorReply(id, "unsupported job-object operation");
  }

  if (job) CloseHandle(job);
  return 0;
}
