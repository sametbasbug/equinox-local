#include <windows.h>

#include <cstdint>
#include <iostream>
#include <sstream>
#include <string>

namespace {
constexpr DWORD kKillOnJobClose = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

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
}  // namespace

int main() {
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
