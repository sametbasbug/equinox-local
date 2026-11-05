/* Read-only terminal session queries; no UI, runtime or permission ownership. */
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Bound both enumeration memory and work, failing closed on a full snapshot. */
#define PID_BUFFER_BYTES (2 * 1024 * 1024)

static int invalid_arguments(void)
{
    fputs("Equinox Local internal process-session query received invalid arguments.\n", stderr);
    return 64;
}

/* Match Swift Int32's positive decimal input, including an optional plus. */
static int parse_positive_pid(const char *raw, pid_t *result)
{
    const unsigned char *cursor = (const unsigned char *)raw;
    uint32_t value = 0;
    if (*cursor == '+') {
        ++cursor;
    }
    if (*cursor == '\0') {
        return 0;
    }
    for (; *cursor != '\0'; ++cursor) {
        if (*cursor < '0' || *cursor > '9') {
            return 0;
        }
        uint32_t digit = (uint32_t)(*cursor - '0');
        if (value > ((uint32_t)INT32_MAX - digit) / 10) {
            return 0;
        }
        value = value * 10 + digit;
    }
    if (value == 0) {
        return 0;
    }
    *result = (pid_t)value;
    return 1;
}

static int compare_pids(const void *left, const void *right)
{
    pid_t a = *(const pid_t *)left;
    pid_t b = *(const pid_t *)right;
    return (a > b) - (a < b);
}

static int list_session_pids(pid_t session_id)
{
    pid_t *pids = malloc(PID_BUFFER_BYTES);
    if (pids == NULL) {
        return 70;
    }
    int bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, PID_BUFFER_BYTES);
    if (bytes <= 0 || bytes >= PID_BUFFER_BYTES || bytes % sizeof(*pids) != 0) {
        free(pids);
        return 70;
    }
    size_t count = (size_t)bytes / sizeof(*pids);
    qsort(pids, count, sizeof(*pids), compare_pids);
    for (size_t index = 0; index < count; ++index) {
        pid_t pid = pids[index];
        /* Process exits and inaccessible entries are skipped, as in Swift. */
        if (pid > 0 && getsid(pid) == session_id) {
            if (printf("%" PRId32 "\n", (int32_t)pid) < 0) {
                free(pids);
                return 70;
            }
        }
    }
    free(pids);
    return fflush(stdout) == 0 ? 0 : 70;
}

int main(int argc, char *argv[])
{
    pid_t requested;
    if (argc != 3 || !parse_positive_pid(argv[2], &requested)) {
        return invalid_arguments();
    }
    if (strcmp(argv[1], "--internal-process-session-id") == 0) {
        pid_t session_id = getsid(requested);
        if (session_id <= 0) {
            return errno == ESRCH ? 3 : 70;
        }
        if (printf("%" PRId32 "\n", (int32_t)session_id) < 0) {
            return 70;
        }
        return fflush(stdout) == 0 ? 0 : 70;
    }
    if (strcmp(argv[1], "--internal-process-session-pids") == 0) {
        return list_session_pids(requested);
    }
    return invalid_arguments();
}
