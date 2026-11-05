#pragma once

#include <windows.h>
#include <sddl.h>
#include <atomic>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

// Private stdio ABI for --shell-control (UTF-8/ASCII, one line per message):
// stdout: {"event":"ready"} | {"event":"duplicate"} |
//         {"event":"error","code":<Win32 code>}
// stdout request: {"event":"request","id":"<decimal>","command":"<wire command>"}
// stdin (uninstall only): ack:<id>:ok\n or ack:<id>:error\n
// stdout after the client has read its uninstall reply:
//         {"event":"acknowledged","id":"<decimal>","ok":true|false}
// Electron must launch/validate its uninstall handoff BEFORE ack:...:ok, and
// keep itself and these stdio pipes alive until acknowledged before teardown.
// Reopen/restart/shutdown have no ack. Unknown commands are never forwarded.
// stdin EOF or "close\n" ends the helper. Use dedicated, non-inherited parent
// pipe ends (never share stdin with another child). No detached helper launch.
namespace equinox_shell_control {
constexpr wchar_t kMutex[] = L"Local\\EquinoxLocal.WindowsShell.SingleInstance";
constexpr wchar_t kPipe[] = L"\\\\.\\pipe\\EquinoxLocal.WindowsShell.Reopen";
static std::atomic<ULONGLONG> deadline{0};
static SRWLOCK ackLock = SRWLOCK_INIT;
static std::string pendingId;
static int ack = 0;

inline void Emit(const std::string& line) {
  deadline.store(GetTickCount64() + 4000);
  std::cout << line << '\n' << std::flush;
  if (!std::cout) ExitProcess(21);
  deadline.store(0);
}

// Independently watches parent stdin even during stdout/FlushFileBuffers.
// Static state is process-lived; returning wmain terminates this thread too.
inline DWORD WINAPI WatchInput(void*) {
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  std::string line;
  for (;;) {
    const auto expires = deadline.load();
    if (expires && GetTickCount64() >= expires) ExitProcess(21);
    DWORD available = 0;
    if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) ExitProcess(0);
    if (!available) { Sleep(10); continue; }
    char ch = 0;
    DWORD count = 0;
    if (!ReadFile(input, &ch, 1, &count, nullptr) || count != 1) ExitProcess(0);
    if (ch != '\n') {
      if (line.size() >= 96) ExitProcess(21);
      line += ch;
      continue;
    }
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line == "close") ExitProcess(0);
    AcquireSRWLockExclusive(&ackLock);
    if (!pendingId.empty() && ack == 0) {
      if (line == "ack:" + pendingId + ":ok") ack = 1;
      else if (line == "ack:" + pendingId + ":error") ack = -1;
    }
    ReleaseSRWLockExclusive(&ackLock);
    line.clear();
  }
}

inline int Failure(DWORD code) {
  Emit("{\"event\":\"error\",\"code\":" + std::to_string(code) + "}");
  return 21;
}

inline int Run() {
  // Anonymous redirected pipes are required, not console/file stdin.
  DWORD available = 0;
  if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr))
    return Failure(ERROR_INVALID_HANDLE);
  HANDLE watcher = CreateThread(nullptr, 0, WatchInput, nullptr, 0, nullptr);
  if (!watcher) return Failure(GetLastError());
  CloseHandle(watcher);

  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return Failure(GetLastError());
  DWORD bytes = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
  if (bytes < sizeof(TOKEN_USER) || bytes > 16384) {
    CloseHandle(token); return Failure(ERROR_INVALID_DATA);
  }
  std::vector<BYTE> user(bytes);
  if (!GetTokenInformation(token, TokenUser, user.data(), bytes, &bytes)) {
    DWORD error = GetLastError(); CloseHandle(token); return Failure(error);
  }
  CloseHandle(token);
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid, &sid))
    return Failure(GetLastError());
  // Protected DACL: only the current token's user, no Everyone/admin grants.
  const std::wstring sddl = L"D:P(A;;GA;;;" + std::wstring(sid) + L")";
  LocalFree(sid);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr))
    return Failure(GetLastError());
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
  HANDLE mutex = CreateMutexW(&security, FALSE, kMutex);
  if (!mutex) {
    DWORD error = GetLastError(); LocalFree(descriptor); return Failure(error);
  }
  const DWORD waited = WaitForSingleObject(mutex, 0);
  if (waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED) {
    const DWORD error = waited == WAIT_FAILED ? GetLastError() : ERROR_SUCCESS;
    CloseHandle(mutex); LocalFree(descriptor);
    if (error) return Failure(error);
    Emit("{\"event\":\"duplicate\"}"); return 20;
  }
  // First-instance prevents silently joining a pre-created/spoofed pipe.
  HANDLE pipe = CreateNamedPipeW(kPipe, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
    1, 512, 512, 0, &security);
  DWORD error = pipe == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  LocalFree(descriptor);
  if (error) { ReleaseMutex(mutex); CloseHandle(mutex); return Failure(error); }
  Emit("{\"event\":\"ready\"}");
  uint64_t sequence = 0;
  for (;;) {
    const BOOL connected = ConnectNamedPipe(pipe, nullptr);
    const DWORD connectionError = connected ? ERROR_SUCCESS : GetLastError();
    if (!connected && connectionError != ERROR_PIPE_CONNECTED) {
      if (connectionError == ERROR_PIPE_LISTENING || connectionError == ERROR_NO_DATA) {
        if (connectionError == ERROR_NO_DATA) DisconnectNamedPipe(pipe);
        Sleep(10); continue;
      }
      error = connectionError; break;
    }
    std::string command;
    const ULONGLONG readDeadline = GetTickCount64() + 3000;
    bool complete = false;
    while (GetTickCount64() < readDeadline && command.size() <= 128) {
      char ch = 0;
      DWORD count = 0;
      const BOOL read = ReadFile(pipe, &ch, 1, &count, nullptr);
      if (read && count == 1) {
        if (ch == '\n') { complete = true; break; }
        command += ch;
      } else {
        if (!read && GetLastError() != ERROR_NO_DATA) break;
        Sleep(10);
      }
    }
    if (!command.empty() && command.back() == '\r') command.pop_back();
    // The old StreamReader accepts a UTF-8 BOM and Windows CRLF writers.
    if (command.compare(0, 3, "\xEF\xBB\xBF") == 0) command.erase(0, 3);
    const bool uninstall = command == "uninstall:preserve-user-data" || command == "uninstall:remove-user-data";
    const bool allowed = uninstall || command == "reopen" || command == "restart-runtime" || command == "shutdown-for-update";
    if (complete && allowed) {
      const std::string id = std::to_string(++sequence);
      if (uninstall) {
        AcquireSRWLockExclusive(&ackLock);
        pendingId = id; ack = 0;
        ReleaseSRWLockExclusive(&ackLock);
      }
      Emit("{\"event\":\"request\",\"id\":\"" + id + "\",\"command\":\"" + command + "\"}");
      if (uninstall) {
        const ULONGLONG ackDeadline = GetTickCount64() + 3000;
        int result = 0;
        while (GetTickCount64() < ackDeadline) {
          AcquireSRWLockShared(&ackLock); result = ack; ReleaseSRWLockShared(&ackLock);
          if (result) break;
          Sleep(10);
        }
        AcquireSRWLockExclusive(&ackLock); pendingId.clear(); ReleaseSRWLockExclusive(&ackLock);
        const std::string response = result == 1 ? "ok\n" : "error:Electron refused or timed out\n";
        DWORD written = 0;
        bool delivered = WriteFile(pipe, response.data(), static_cast<DWORD>(response.size()), &written, nullptr) && written == response.size();
        // Disconnect discards unread data. Flush before announcing teardown is
        // safe; watchdog bounds a client that never consumes its reply.
        if (delivered) {
          deadline.store(GetTickCount64() + 3000);
          delivered = FlushFileBuffers(pipe) != FALSE;
          deadline.store(0);
        }
        Emit("{\"event\":\"acknowledged\",\"id\":\"" + id + "\",\"ok\":" + (delivered && result == 1 ? "true}" : "false}"));
      }
    }
    DisconnectNamedPipe(pipe);
  }
  CloseHandle(pipe);
  ReleaseMutex(mutex);
  CloseHandle(mutex);
  return Failure(error);
}
}  // namespace equinox_shell_control
