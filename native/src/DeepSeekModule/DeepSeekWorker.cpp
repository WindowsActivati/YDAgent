// ============================================================================
//  DeepSeekWorker 实现 —— 自包含 HTTPS 客户端
//
//  不依赖系统 libcurl / openssl：
//    · POSIX socket（非阻塞 connect + poll 超时）
//    · mbedtls 2.28.9（third_party/mbedtls，已排除 net_sockets.c，自定义 bio）
//    · 嵌入式 CA 证书 cacert.h（build.sh 用 xxd -i 从 cacert.pem 生成）
//    · MiniJson.hpp（header-only）解析/序列化
//
//  超时统一由 timeout_ms 驱动（连接/DNS 后所有 poll 均带 deadline）。
// ============================================================================

#include "DeepSeekWorker.hpp"
#include "MiniJson.hpp"
#include "cacert.h"

#include <mbedtls/ctr_drbg.h>
#include <mbedtls/entropy.h>
#include <mbedtls/error.h>
#include <mbedtls/net_sockets.h> // 仅取 MBEDTLS_ERR_NET_SEND_FAILED / MBEDTLS_ERR_NET_RECV_FAILED 宏
#include <mbedtls/ssl.h>
#include <mbedtls/x509_crt.h>

#include <arpa/inet.h>
#include <cerrno>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <vector>

namespace {

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
uint64_t nowMs()
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
}

std::string lower(std::string s)
{
    for (char &c : s)
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    return s;
}

std::string trim(const std::string &s)
{
    size_t b = 0, e = s.size();
    while (b < e && (s[b] == ' ' || s[b] == '\t' || s[b] == '\r')) ++b;
    while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t' || s[e - 1] == '\r')) --e;
    return s.substr(b, e - b);
}

std::string errnoStr()
{
    char buf[128];
    snprintf(buf, sizeof buf, "errno=%d", errno);
    return std::string(buf);
}

// ---------------------------------------------------------------------------
// URL 解析：https://host[:port][/path]  （仅支持 https）
// ---------------------------------------------------------------------------
struct UrlParts
{
    std::string scheme;
    std::string host;
    int port = 443;
    std::string path = "/";
};

bool parseUrl(const std::string &raw, UrlParts &out)
{
    std::string s = trim(raw);
    size_t sep = s.find("://");
    if (sep == std::string::npos) return false;
    out.scheme = lower(s.substr(0, sep));
    if (out.scheme != "https") return false;

    size_t p = sep + 3;
    size_t slash = s.find('/', p);
    std::string authority = (slash == std::string::npos) ? s.substr(p) : s.substr(p, slash - p);

    size_t at = authority.rfind('@');
    if (at != std::string::npos) authority = authority.substr(at + 1); // 忽略 userinfo

    size_t colon = authority.rfind(':');
    if (colon != std::string::npos && authority.find(']') == std::string::npos)
    {
        out.host = authority.substr(0, colon);
        out.port = atoi(authority.substr(colon + 1).c_str());
        if (out.port <= 0 || out.port > 65535) return false;
    }
    else
    {
        out.host = authority;
        out.port = 443;
    }
    if (out.host.empty()) return false;

    if (slash != std::string::npos)
        out.path = s.substr(slash);
    else
        out.path = "/";
    return true;
}

// ---------------------------------------------------------------------------
// TlsClient —— mbedtls 自包含客户端
// ---------------------------------------------------------------------------
class TlsClient
{
public:
    explicit TlsClient(int timeoutMs) : timeoutMs_(timeoutMs) {}
    ~TlsClient() { close(); }
    TlsClient(const TlsClient &) = delete;
    TlsClient &operator=(const TlsClient &) = delete;

    // 连接 + TLS 初始化（不握手）
    bool open(const std::string &host, int port, std::string &errOut);

    // 完成 TLS 握手
    bool handshake(std::string &errOut);

    // 加密写全部数据
    bool writeAll(const std::string &data, std::string &errOut);

    // 明文读：>0 数据；0 EOF；-1 超时；-2 错误
    int readSome(char *buf, size_t cap, std::string &errOut);

private:
    // mbedtls f_send / f_recv 适配（bio ctx = this）
    static int bioSend(void *ctx, const unsigned char *buf, size_t len);
    static int bioRecv(void *ctx, unsigned char *buf, size_t len);

    int rawRecv(char *buf, size_t cap, std::string &errOut);

    void close()
    {
        if (tlsInit_)
        {
            mbedtls_ssl_free(&ssl_);
            mbedtls_ssl_config_free(&conf_);
            mbedtls_x509_crt_free(&cacert_);
            mbedtls_ctr_drbg_free(&ctrDrbg_);
            mbedtls_entropy_free(&entropy_);
            tlsInit_ = false;
        }
        if (fd_ >= 0)
        {
            ::close(fd_);
            fd_ = -1;
        }
    }

    int fd_ = -1;
    int timeoutMs_;
    uint64_t deadline_ = 0;
    bool tlsInit_ = false;

    mbedtls_ssl_context ssl_;
    mbedtls_ssl_config conf_;
    mbedtls_x509_crt cacert_;
    mbedtls_ctr_drbg_context ctrDrbg_;
    mbedtls_entropy_context entropy_;
};

// 非阻塞 connect + poll，返回 0 成功 / -1 失败（errno 已设置）
int connectWithTimeout(int fd, const struct sockaddr *addr, socklen_t len, uint64_t deadline)
{
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);

    int rc = ::connect(fd, addr, len);
    if (rc == 0)
    {
        // connect 立即成功（如本地回环）
        fcntl(fd, F_SETFL, flags);
        return 0;
    }
    if (errno != EINPROGRESS)
    {
        fcntl(fd, F_SETFL, flags);
        return -1;
    }

    int64_t remain = (int64_t)(deadline - nowMs());
    if (remain <= 0)
    {
        errno = ETIMEDOUT;
        fcntl(fd, F_SETFL, flags);
        return -1;
    }

    struct pollfd pfd;
    pfd.fd = fd;
    pfd.events = POLLOUT;
    pfd.revents = 0;
    int pr = ::poll(&pfd, 1, (int)remain);
    if (pr <= 0)
    {
        errno = (pr == 0) ? ETIMEDOUT : EIO;
        fcntl(fd, F_SETFL, flags);
        return -1;
    }

    int soerr = 0;
    socklen_t sl = sizeof soerr;
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &sl) != 0 || soerr != 0)
    {
        errno = (soerr != 0) ? soerr : EIO;
        fcntl(fd, F_SETFL, flags);
        return -1;
    }
    fcntl(fd, F_SETFL, flags);
    return 0;
}

bool TlsClient::open(const std::string &host, int port, std::string &errOut)
{
    deadline_ = nowMs() + (uint64_t)timeoutMs_;

    // 1) DNS
    struct addrinfo hints;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo *res = nullptr;
    std::string portStr = std::to_string(port);
    int grc = getaddrinfo(host.c_str(), portStr.c_str(), &hints, &res);
    if (grc != 0 || res == nullptr)
    {
        errOut = "DNS 解析失败: " + std::string(gai_strerror(grc));
        return false;
    }

    // 2) 连接（逐个候选地址）
    int fd = -1;
    for (struct addrinfo *ai = res; ai != nullptr; ai = ai->ai_next)
    {
        fd = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) continue;
        if (connectWithTimeout(fd, ai->ai_addr, (socklen_t)ai->ai_addrlen, deadline_) == 0)
            break;
        ::close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    if (fd < 0)
    {
        errOut = "连接 " + host + ":" + portStr + " 失败 (" + errnoStr() + ")";
        return false;
    }
    fd_ = fd;

    // 3) mbedtls 初始化
    mbedtls_entropy_init(&entropy_);
    mbedtls_ctr_drbg_init(&ctrDrbg_);
    mbedtls_x509_crt_init(&cacert_);
    mbedtls_ssl_init(&ssl_);
    mbedtls_ssl_config_init(&conf_);
    tlsInit_ = true;

    if (mbedtls_ctr_drbg_seed(&ctrDrbg_, mbedtls_entropy_func, &entropy_, nullptr, 0) != 0)
    {
        errOut = "随机数初始化失败";
        return false;
    }

    // mbedtls 2.28 的 mbedtls_x509_crt_parse 仅在输入缓冲区以 '\0' 结尾时才按 PEM
    // 解析（x509_crt.c: buf[buflen-1]=='\0' → buf_format=PEM），否则整包 PEM 文本
    // 会被当作 DER 解析 → INVALID_FORMAT(-0x2180)。cacert_pem 数组（xxd -i 生成）
    // 无结尾 NUL，这里静态复制一份并补 '\0'，保证走 PEM 分支（线程安全：magic static）。
    static const std::vector<unsigned char> s_cacert_pem = [] {
        std::vector<unsigned char> v(cacert_pem, cacert_pem + cacert_pem_len);
        v.push_back('\0');
        return v;
    }();
    int pr = mbedtls_x509_crt_parse(&cacert_, s_cacert_pem.data(), s_cacert_pem.size());
    if (pr != 0)
    {
        // 暴露具体 mbedtls 错误码（负值，如 -0x2680），便于精确定位
        char ebuf[160];
        mbedtls_strerror(pr, ebuf, sizeof ebuf);
        char buf[256];
        snprintf(buf, sizeof buf, "CA 证书解析失败 (-0x%04x): %s",
                 (unsigned)(-pr), ebuf);
        errOut = buf;
        return false;
    }

    mbedtls_ssl_config_defaults(&conf_, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM,
                                MBEDTLS_SSL_PRESET_DEFAULT);
    mbedtls_ssl_conf_authmode(&conf_, MBEDTLS_SSL_VERIFY_REQUIRED);
    mbedtls_ssl_conf_ca_chain(&conf_, &cacert_, nullptr);
    mbedtls_ssl_conf_rng(&conf_, mbedtls_ctr_drbg_random, &ctrDrbg_);

    if (mbedtls_ssl_setup(&ssl_, &conf_) != 0)
    {
        errOut = "TLS 上下文初始化失败";
        return false;
    }
    if (mbedtls_ssl_set_hostname(&ssl_, host.c_str()) != 0)
    {
        errOut = "TLS SNI 设置失败";
        return false;
    }
    mbedtls_ssl_set_bio(&ssl_, this, &TlsClient::bioSend, &TlsClient::bioRecv, nullptr);
    return true;
}

bool TlsClient::handshake(std::string &errOut)
{
    int ret;
    do
    {
        ret = mbedtls_ssl_handshake(&ssl_);
    } while (ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE);

    if (ret != 0)
    {
        char buf[160];
        mbedtls_strerror(ret, buf, sizeof buf);
        errOut = "TLS 握手失败: " + std::string(buf);
        return false;
    }
    return true;
}

bool TlsClient::writeAll(const std::string &data, std::string &errOut)
{
    size_t sent = 0;
    while (sent < data.size())
    {
        int n = mbedtls_ssl_write(&ssl_, (const unsigned char *)data.data() + sent, data.size() - sent);
        if (n > 0)
        {
            sent += (size_t)n;
            continue;
        }
        if (n == MBEDTLS_ERR_SSL_WANT_READ || n == MBEDTLS_ERR_SSL_WANT_WRITE)
            continue; // 阻塞 bio 下理论不会出现，防御
        if (n == MBEDTLS_ERR_SSL_TIMEOUT)
        {
            errOut = "发送超时";
            return false;
        }
        char buf[160];
        mbedtls_strerror(n, buf, sizeof buf);
        errOut = "发送失败: " + std::string(buf);
        return false;
    }
    return true;
}

int TlsClient::rawRecv(char *buf, size_t cap, std::string &errOut)
{
    int64_t remain = (int64_t)(deadline_ - nowMs());
    if (remain <= 0)
    {
        errOut = "timeout";
        return -1;
    }
    struct pollfd pfd;
    pfd.fd = fd_;
    pfd.events = POLLIN;
    pfd.revents = 0;
    for (;;)
    {
        int pr = ::poll(&pfd, 1, (int)remain);
        if (pr > 0) break;
        if (pr == 0)
        {
            errOut = "timeout";
            return -1;
        }
        if (errno == EINTR) continue;
        errOut = "poll 失败 (" + errnoStr() + ")";
        return -2;
    }
    for (;;)
    {
        ssize_t n = ::recv(fd_, buf, cap, 0);
        if (n > 0) return (int)n;
        if (n == 0) return 0; // EOF
        if (errno == EINTR) continue;
        errOut = "recv 失败 (" + errnoStr() + ")";
        return -2;
    }
}

int TlsClient::readSome(char *buf, size_t cap, std::string &errOut)
{
    for (;;)
    {
        int n = mbedtls_ssl_read(&ssl_, (unsigned char *)buf, cap);
        if (n > 0) return n;
        if (n == MBEDTLS_ERR_SSL_WANT_READ || n == MBEDTLS_ERR_SSL_WANT_WRITE)
            continue; // 阻塞 bio 下理论不会出现，防御
        // EOF 的三种形态，都按「连接正常结束」处理：
        //   n == 0                          对端直接关闭 TCP（无 close_notify）
        //   MBEDTLS_ERR_SSL_CONN_EOF        读到 TCP EOF
        //   MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY  对端发来 close_notify（TLS 层正常收尾）
        // 注意第三种：服务器用 Connection: close 时，发完响应就发 close_notify。
        // 若把它当错误返回，会丢掉「已经收全的响应体」并误报「网络不可用」。
        if (n == 0 || n == MBEDTLS_ERR_SSL_CONN_EOF || n == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY)
            return 0; // EOF
        if (n == MBEDTLS_ERR_SSL_TIMEOUT)
        {
            errOut = "timeout";
            return -1;
        }
        char buf2[160];
        mbedtls_strerror(n, buf2, sizeof buf2);
        errOut = buf2;
        return -2;
    }
}

int TlsClient::bioSend(void *ctx, const unsigned char *buf, size_t len)
{
    TlsClient *self = static_cast<TlsClient *>(ctx);
    size_t sent = 0;
    while (sent < len)
    {
        ssize_t n = ::send(self->fd_, buf + sent, len - sent, MSG_NOSIGNAL);
        if (n > 0)
        {
            sent += (size_t)n;
            continue;
        }
        if (n < 0 && errno == EINTR) continue;
        return MBEDTLS_ERR_NET_SEND_FAILED;
    }
    return (int)sent;
}

int TlsClient::bioRecv(void *ctx, unsigned char *buf, size_t len)
{
    TlsClient *self = static_cast<TlsClient *>(ctx);
    std::string err;
    int n = self->rawRecv((char *)buf, len, err);
    if (n > 0) return n;
    if (n == 0) return 0; // EOF
    if (n == -1) return MBEDTLS_ERR_SSL_TIMEOUT;
    return MBEDTLS_ERR_NET_RECV_FAILED;
}

// ---------------------------------------------------------------------------
// HTTP 响应 + 读取缓冲
// ---------------------------------------------------------------------------
struct HttpResp
{
    int status = 0;
    std::vector<std::pair<std::string, std::string>> headers; // key 已小写
    std::string body;
};

const std::string *headerFind(const HttpResp &r, const char *name)
{
    for (const auto &kv : r.headers)
        if (kv.first == name) return &kv.second;
    return nullptr;
}

class RecvBuf
{
public:
    explicit RecvBuf(TlsClient &t) : tls_(t) {}

    bool readUntil(const std::string &delim, std::string &out, size_t maxLen, std::string &errOut)
    {
        out.clear();
        while (true)
        {
            size_t found = buf_.find(delim, pos_);
            if (found != std::string::npos)
            {
                out.append(buf_, pos_, found - pos_);
                pos_ = found + delim.size();
                return true;
            }
            // 未命中：只消费不会破坏跨缓冲匹配的部分（保留 delim.size()-1 字节）
            size_t keep = delim.size() > 1 ? delim.size() - 1 : 0;
            // 必须防下溢：首次调用时 buf_ 为空（size 0 < keep 3），无符号相减会
            // 得到 SIZE_MAX-2，pos_ 随即被写成该巨值 → 之后 find(delim, pos_)
            // 因 pos_ > size() 永远返回 npos → 分隔符永远匹配不上 → 一路读到
            // 对端关闭才报错，丢掉已经收全的响应。务必用比较保护。
            size_t consumable = buf_.size() > keep ? buf_.size() - keep : 0;
            if (consumable > pos_)
            {
                out.append(buf_, pos_, consumable - pos_);
                pos_ = consumable;
            }
            if (out.size() > maxLen)
            {
                errOut = "响应数据过大";
                return false;
            }
            if (!fill(errOut)) return false; // EOF / 超时 / 错误
        }
    }

    bool readN(size_t n, std::string &out, std::string &errOut)
    {
        while (out.size() < n)
        {
            size_t avail = buf_.size() - pos_;
            if (avail > 0)
            {
                size_t take = avail < (n - out.size()) ? avail : (n - out.size());
                out.append(buf_, pos_, take);
                pos_ += take;
                continue;
            }
            if (!fill(errOut)) return false;
        }
        return true;
    }

    // Connection: close → 读到 EOF 结束（EOF 视为正常）
    bool readToEof(std::string &out, std::string &errOut)
    {
        out.append(buf_, pos_, buf_.size() - pos_);
        pos_ = buf_.size();
        while (!eof_)
        {
            if (!fill(errOut))
            {
                return eof_; // EOF 正常收尾，其余为错误
            }
            out.append(buf_, pos_, buf_.size() - pos_);
            pos_ = buf_.size();
        }
        return true;
    }

private:
    bool fill(std::string &errOut)
    {
        if (eof_) return false;
        char tmp[4096];
        int n = tls_.readSome(tmp, sizeof tmp, errOut);
        if (n > 0)
        {
            buf_.append(tmp, (size_t)n);
            return true;
        }
        if (n == 0)
        {
            eof_ = true;
            return false;
        }
        return false; // n < 0：errOut 已设置（timeout/错误）
    }

    TlsClient &tls_;
    std::string buf_;
    size_t pos_ = 0;
    bool eof_ = false;
};

// ---------------------------------------------------------------------------
// 响应解析辅助
// ---------------------------------------------------------------------------
std::string statusText(int status)
{
    switch (status)
    {
    case 400: return "请求参数错误 (400)";
    case 401: return "认证失败：API Key 无效或已过期 (401)";
    case 403: return "无权限访问 (403)";
    case 404: return "接口不存在 (404)";
    case 408: return "请求超时 (408)";
    case 429: return "请求过于频繁，触发限流 (429)";
    case 500: return "服务器内部错误 (500)";
    case 502: return "网关错误 (502)";
    case 503: return "服务暂不可用 (503)";
    default: return "HTTP 错误 (" + std::to_string(status) + ")";
    }
}

std::string statusCode(int status)
{
    if (status == 401) return "authentication_error";
    if (status == 403) return "permission_denied";
    if (status == 404) return "not_found";
    if (status == 408) return "timeout";
    if (status == 429) return "rate_limit_exceeded";
    if (status >= 500) return "server_error";
    if (status == 400) return "invalid_request";
    return "http_error";
}

// 提取 choices[0].message.content（需为字符串且非空）
bool extractContent(const JVal &body, std::string &out)
{
    if (body.type != JVal::OBJ) return false;
    const JVal *choices = body.find("choices");
    if (choices == nullptr || choices->type != JVal::ARR || choices->arr.empty()) return false;
    const JVal *msg = choices->at(0)->find("message");
    if (msg == nullptr) return false;
    const JVal *content = msg->find("content");
    if (content == nullptr || content->type != JVal::STR) return false;
    out = content->str;
    return true;
}

// 提取 choices[0].message.tool_calls（function calling）。
// 命中时把整段 tool_calls 序列化成 JSON 文本交给 JS 侧处理
// （JS 负责校验、请求用户授权、再回填结果）。
bool extractToolCalls(const JVal &body, std::string &outJson)
{
    if (body.type != JVal::OBJ) return false;
    const JVal *choices = body.find("choices");
    if (choices == nullptr || choices->type != JVal::ARR || choices->arr.empty()) return false;
    const JVal *msg = choices->at(0)->find("message");
    if (msg == nullptr || msg->type != JVal::OBJ) return false;
    const JVal *tc = msg->find("tool_calls");
    if (tc == nullptr || tc->type != JVal::ARR || tc->arr.empty()) return false;
    outJson = tc->dump();
    return true;
}

// 提取 error.message（存在则覆盖默认错误文案）
void extractError(const JVal &body, std::string &out)
{
    if (body.type != JVal::OBJ) return;
    const JVal *err = body.find("error");
    if (err == nullptr || err->type != JVal::OBJ) return;
    const JVal *msg = err->find("message");
    if (msg != nullptr && msg->type == JVal::STR && !msg->str.empty()) out = msg->str;
}

std::string buildOk(const std::string &content)
{
    return "{\"ok\":true,\"content\":\"" + JVal::escape(content) + "\"}";
}

std::string buildErr(const std::string &code, const std::string &msg, int status)
{
    std::string s = "{\"ok\":false,\"error\":{\"code\":\"" + JVal::escape(code) +
                    "\",\"message\":\"" + JVal::escape(msg) + "\"";
    if (status > 0)
        s += ",\"status\":" + std::to_string(status);
    s += "}}";
    return s;
}

// ---------------------------------------------------------------------------
// HTTP POST（TLS 已就绪）
// ---------------------------------------------------------------------------
bool httpPost(TlsClient &tls, const std::string &host, int port, const std::string &path,
              const std::string &apiKey, const std::string &payload,
              HttpResp &out, std::string &errOut)
{
    std::string req;
    req += "POST " + path + " HTTP/1.1\r\n";
    req += "Host: " + host;
    if (port != 443) req += ":" + std::to_string(port);
    req += "\r\n";
    req += "Content-Type: application/json\r\n";
    req += "Authorization: Bearer " + apiKey + "\r\n";
    req += "Accept: application/json\r\n";
    req += "Content-Length: " + std::to_string(payload.size()) + "\r\n";
    req += "Connection: close\r\n";
    req += "\r\n";
    req += payload;

    if (!tls.writeAll(req, errOut)) return false;

    RecvBuf rb(tls);

    // 1) 状态行 + 头（到空行）
    std::string head;
    if (!rb.readUntil("\r\n\r\n", head, 16384, errOut))
    {
        if (errOut.empty()) errOut = "读取响应头失败";
        return false;
    }

    size_t eol = head.find("\r\n");
    std::string statusLine = (eol == std::string::npos) ? head : head.substr(0, eol);
    size_t sp1 = statusLine.find(' ');
    if (sp1 == std::string::npos)
    {
        errOut = "非法响应状态行";
        return false;
    }
    size_t sp2 = statusLine.find(' ', sp1 + 1);
    std::string codeStr = statusLine.substr(sp1 + 1, (sp2 == std::string::npos) ? std::string::npos : sp2 - sp1 - 1);
    out.status = atoi(codeStr.c_str());

    // 2) 头部字段（key 转小写）
    size_t pos = eol == std::string::npos ? 0 : eol + 2;
    while (pos < head.size())
    {
        size_t e = head.find("\r\n", pos);
        if (e == std::string::npos || e == pos) break;
        std::string line = head.substr(pos, e - pos);
        size_t colon = line.find(':');
        if (colon != std::string::npos)
        {
            std::string key = lower(trim(line.substr(0, colon)));
            std::string val = trim(line.substr(colon + 1));
            out.headers.push_back({key, val});
        }
        pos = e + 2;
    }

    // 3) body
    const std::string *cl = headerFind(out, "content-length");
    if (cl != nullptr)
    {
        size_t len = (size_t)strtoul(cl->c_str(), nullptr, 10);
        if (len > 0 && !rb.readN(len, out.body, errOut))
        {
            if (errOut.empty()) errOut = "读取响应体失败（内容被截断）";
            return false;
        }
        return out.status > 0;
    }

    const std::string *te = headerFind(out, "transfer-encoding");
    if (te != nullptr && lower(*te).find("chunked") != std::string::npos)
    {
        for (;;)
        {
            std::string line;
            if (!rb.readUntil("\r\n", line, 4096, errOut))
            {
                if (errOut.empty()) errOut = "读取 chunk 大小失败";
                return false;
            }
            size_t semi = line.find(';');
            std::string szStr = line.substr(0, semi);
            size_t sz = (size_t)strtoul(szStr.c_str(), nullptr, 16);
            if (sz == 0) break;
            if (!rb.readN(sz, out.body, errOut)) return false;
            std::string crlf;
            if (!rb.readN(2, crlf, errOut)) return false; // 块尾 CRLF
        }
        return out.status > 0;
    }

    // 无长度无 chunked → Connection: close 读到 EOF
    if (!rb.readToEof(out.body, errOut))
    {
        if (errOut.empty()) errOut = "读取响应体失败";
        return false;
    }
    return out.status > 0;
}

// ---------------------------------------------------------------------------
// 流式响应体：按行读取（chunked 模式自动解编码），供 SSE 解析使用
// ---------------------------------------------------------------------------
class BodyStream
{
public:
    BodyStream(RecvBuf &rb, bool chunked) : rb_(rb), chunked_(chunked) {}

    // 读一行（不含行尾 \n，已剥掉 \r）；返回 false = 流结束或出错
    bool readLine(std::string &line, std::string &errOut)
    {
        line.clear();
        char c;
        while (nextByte(c, errOut))
        {
            if (c == '\n')
            {
                if (!line.empty() && line.back() == '\r') line.pop_back();
                return true;
            }
            line.push_back(c);
            if (line.size() > 262144) // 单行 256KB 上限，防御异常服务端
            {
                errOut = "SSE 单行过大";
                return false;
            }
        }
        return false;
    }

private:
    // 取一个正文字节；chunked 模式下自动跳过块长度行与块尾 CRLF
    bool nextByte(char &c, std::string &errOut)
    {
        if (!chunked_)
        {
            std::string one;
            if (!rb_.readN(1, one, errOut)) return false;
            c = one[0];
            return true;
        }

        if (chunkDone_) return false;
        if (chunkRemain_ == 0)
        {
            std::string sizeLine;
            if (!rb_.readUntil("\r\n", sizeLine, 4096, errOut)) return false;
            // 允许块扩展（如 "1a;ext=val"），只取分号前的十六进制长度
            size_t semi = sizeLine.find(';');
            std::string hex = (semi == std::string::npos) ? sizeLine : sizeLine.substr(0, semi);
            unsigned long sz = strtoul(hex.c_str(), nullptr, 16);
            if (sz == 0) { chunkDone_ = true; return false; } // 结束块
            chunkRemain_ = (size_t)sz;
        }
        std::string one;
        if (!rb_.readN(1, one, errOut)) return false;
        c = one[0];
        if (--chunkRemain_ == 0)
        {
            std::string crlf;
            if (!rb_.readN(2, crlf, errOut)) return false; // 块尾 CRLF
        }
        return true;
    }

    RecvBuf &rb_;
    bool chunked_;
    size_t chunkRemain_ = 0;
    bool chunkDone_ = false;
};

// SSE 单行解析结果
struct SseDelta
{
    bool done = false;       // 收到 [DONE]
    std::string content;     // 本行携带的正文增量
    std::string errorMsg;    // 服务端在流中下发的错误
};

// 解析一行 SSE。返回 false = 该行无内容（空行/注释/心跳/无 delta）
bool parseSseLine(const std::string &line, SseDelta &out)
{
    if (line.empty() || line[0] == ':') return false;       // 空行 / 注释心跳
    if (line.compare(0, 5, "data:") != 0) return false;     // event: / id: / retry: 等

    std::string payload = line.substr(5);
    size_t b = payload.find_first_not_of(' ');
    payload = (b == std::string::npos) ? std::string() : payload.substr(b);
    if (payload.empty()) return false;
    if (payload == "[DONE]") { out.done = true; return true; }

    JVal v = JVal::parse(payload);
    if (v.type != JVal::OBJ) return false;

    // 服务端错误（流中途也可能下发）
    const JVal *err = v.find("error");
    if (err != nullptr && err->type == JVal::OBJ)
    {
        const JVal *m = err->find("message");
        out.errorMsg = (m != nullptr && m->type == JVal::STR) ? m->str : "服务端返回错误";
        return true;
    }

    const JVal *choices = v.find("choices");
    if (choices == nullptr || choices->type != JVal::ARR || choices->arr.empty()) return false;
    const JVal *delta = choices->at(0)->find("delta");
    if (delta == nullptr) return false;
    const JVal *content = delta->find("content");
    if (content != nullptr && content->type == JVal::STR && !content->str.empty())
    {
        out.content = content->str;
        return true;
    }
    return false; // 只有 role/finish_reason 的块
}

// ---------------------------------------------------------------------------
// SSE 流式 POST：边收边把增量正文交给 onDelta
//   返回 true：statusOut 为 HTTP 状态；2xx 时 fullText = 完整正文
//   返回 false：errOut 带原因（"timeout" / 具体错误）
// ---------------------------------------------------------------------------
bool httpPostStream(TlsClient &tls, const std::string &host, int port, const std::string &path,
                    const std::string &apiKey, const std::string &payload,
                    const DeepSeekWorker::DeltaFn &onDelta,
                    int &statusOut, std::string &fullText, std::string &errOut)
{
    std::string req;
    req += "POST " + path + " HTTP/1.1\r\n";
    req += "Host: " + host;
    if (port != 443) req += ":" + std::to_string(port);
    req += "\r\n";
    req += "Content-Type: application/json\r\n";
    req += "Authorization: Bearer " + apiKey + "\r\n";
    req += "Accept: text/event-stream\r\n";
    req += "Content-Length: " + std::to_string(payload.size()) + "\r\n";
    req += "Connection: close\r\n";
    req += "\r\n";
    req += payload;

    if (!tls.writeAll(req, errOut)) return false;

    RecvBuf rb(tls);

    // 1) 状态行 + 头
    std::string head;
    if (!rb.readUntil("\r\n\r\n", head, 16384, errOut))
    {
        if (errOut.empty()) errOut = "读取响应头失败";
        return false;
    }
    size_t eol = head.find("\r\n");
    std::string statusLine = (eol == std::string::npos) ? head : head.substr(0, eol);
    size_t sp1 = statusLine.find(' ');
    if (sp1 == std::string::npos) { errOut = "非法响应状态行"; return false; }
    size_t sp2 = statusLine.find(' ', sp1 + 1);
    std::string codeStr = statusLine.substr(sp1 + 1, (sp2 == std::string::npos) ? std::string::npos : sp2 - sp1 - 1);
    statusOut = atoi(codeStr.c_str());

    bool chunked = lower(head).find("transfer-encoding: chunked") != std::string::npos;
    BodyStream body(rb, chunked);

    // 2) 非 2xx：把 body 原样收下交给上层解析错误文案（服务端此时返回普通 JSON）
    if (statusOut < 200 || statusOut >= 300)
    {
        std::string line, lineErr;
        while (true)
        {
            lineErr.clear();
            if (!body.readLine(line, lineErr)) break;
            fullText += line;
            if (fullText.size() > 65536) break;
        }
        errOut.clear();
        return true;
    }

    // 3) 2xx：逐行解析 SSE
    std::string line, lineErr;
    errOut.clear();
    for (;;)
    {
        lineErr.clear();
        if (!body.readLine(line, lineErr))
        {
            // 对端正常关闭（PEER_CLOSE_NOTIFY/EOF）→ lineErr 为空，属正常收尾
            if (!lineErr.empty()) { errOut = lineErr; return false; }
            break;
        }

        SseDelta d;
        if (!parseSseLine(line, d)) continue;

        if (!d.errorMsg.empty()) { errOut = d.errorMsg; return false; }

        if (!d.content.empty())
        {
            if (fullText.size() + d.content.size() > 1048576)
            {
                errOut = "响应数据过大";
                return false;
            }
            fullText += d.content;
            if (onDelta) onDelta(d.content); // 工作线程回调，由调用方负责 marshal
        }
        if (d.done) break;
    }

    // 部分网关不发 [DONE] 直接关流：只要收到过正文就算成功
    if (fullText.empty())
    {
        errOut = "流式响应为空";
        return false;
    }
    return true;
}

// 提取请求字段辅助
std::string strField(const JVal &root, const char *key, const std::string &def)
{
    const JVal *v = root.find(key);
    return (v != nullptr && v->type == JVal::STR) ? v->str : def;
}

} // namespace

// ============================================================================
// DeepSeekWorker 实现
// ============================================================================

std::string DeepSeekWorker::readDeviceConfig() const
{
    const char *path = "/etc/miniapp/resources/cfg.json";
    FILE *f = fopen(path, "rb");
    if (f == nullptr) return "";

    std::string out;
    char buf[4096];
    size_t total = 0;
    for (;;)
    {
        size_t n = fread(buf, 1, sizeof buf, f);
        if (n == 0) break;
        total += n;
        if (total > 65536)
        {
            fclose(f);
            return ""; // 超过 64KB，丢弃
        }
        out.append(buf, n);
    }
    fclose(f);
    return out;
}

// ---------------------------------------------------------------------------
// 本地持久化：路径推断 + 整文件读写
// ---------------------------------------------------------------------------

// 从 /proc/self/maps 找到本 .so 的加载路径，反推 app 私有 data 目录。
// .so 加载在 <appRoot>/a/libs/libjsapi_deepseek_<rand>.so，
// 目标路径为 <appRoot>/data/deepseek_store.json。
// 不硬编码 appid：换 appid 或路径布局变化时自动跟随。
std::string DeepSeekWorker::storePath() const
{
    std::string appRoot;
    FILE *f = fopen("/proc/self/maps", "r");
    if (f != nullptr)
    {
        char line[2048];
        while (fgets(line, sizeof line, f) != nullptr)
        {
            if (strstr(line, "libjsapi_deepseek") == nullptr) continue;
            char *slash = strchr(line, '/'); // maps 行：addr perms off dev inode /path
            if (slash == nullptr) continue;
            char *nl = strchr(slash, '\n');
            if (nl != nullptr) *nl = '\0';
            std::string soPath(slash);

            // 截到 ".../pkg/<appid>"：<appRoot>/a/libs/xxx.so
            size_t pkgPos = soPath.find("/pkg/");
            if (pkgPos == std::string::npos) continue;
            size_t appIdEnd = soPath.find('/', pkgPos + 5);
            if (appIdEnd == std::string::npos) continue;
            appRoot = soPath.substr(0, appIdEnd);
            break;
        }
        fclose(f);
    }

    if (appRoot.empty())
    {
        // 兜底：已知布局（推断失败时至少还有一条路）
        appRoot = "/userdisk/secondary/miniapp/data/mini_app/pkg/8000000000009871";
    }
    return appRoot + "/data/deepseek_store.json";
}

std::string DeepSeekWorker::loadStore() const
{
    std::string path = storePath();
    FILE *f = fopen(path.c_str(), "rb");
    if (f == nullptr) return ""; // 首次运行：文件还不存在

    std::string out;
    char buf[4096];
    size_t total = 0;
    for (;;)
    {
        size_t n = fread(buf, 1, sizeof buf, f);
        if (n == 0) break;
        total += n;
        if (total > 1048576) // 1MB 上限，防御异常大文件
        {
            fclose(f);
            return "";
        }
        out.append(buf, n);
    }
    fclose(f);
    return out;
}

std::string DeepSeekWorker::saveStore(const std::string &content) const
{
    std::string path = storePath();

    // 确保 data 目录存在（Falcon 通常会建，但首次或重装后可能没有）
    size_t slash = path.rfind('/');
    if (slash != std::string::npos)
    {
        std::string dir = path.substr(0, slash);
        // 逐级 mkdir（已存在时返回 EEXIST，忽略）
        for (size_t i = 1; i <= dir.size(); i++)
        {
            if (i == dir.size() || dir[i] == '/')
            {
                std::string sub = dir.substr(0, i);
                ::mkdir(sub.c_str(), 0755);
            }
        }
    }

    // 先写临时文件再 rename：避免写一半掉电/被杀导致文件损坏
    std::string tmp = path + ".tmp";
    FILE *f = fopen(tmp.c_str(), "wb");
    if (f == nullptr)
        return "{\"ok\":false,\"error\":\"open failed\"}";
    size_t written = fwrite(content.data(), 1, content.size(), f);
    int flushRc = fflush(f);
    int closeRc = fclose(f);
    if (written != content.size() || flushRc != 0 || closeRc != 0)
    {
        ::remove(tmp.c_str());
        return "{\"ok\":false,\"error\":\"write failed\"}";
    }
    if (::rename(tmp.c_str(), path.c_str()) != 0)
    {
        ::remove(tmp.c_str());
        return "{\"ok\":false,\"error\":\"rename failed\"}";
    }
    return "{\"ok\":true}";
}

// ---------------------------------------------------------------------------
// 文件读写（AI 工具调用）
// ---------------------------------------------------------------------------

namespace {

// 逐级 mkdir -p
void mkdirsFor(const std::string &filePath)
{
    size_t slash = filePath.rfind('/');
    if (slash == std::string::npos || slash == 0) return;
    std::string dir = filePath.substr(0, slash);
    for (size_t i = 1; i <= dir.size(); i++)
    {
        if (i == dir.size() || dir[i] == '/')
        {
            std::string sub = dir.substr(0, i);
            ::mkdir(sub.c_str(), 0755); // 已存在返回 EEXIST，忽略
        }
    }
}

// 按行切分（保留行内容，不含换行符）
std::vector<std::string> splitLines(const std::string &s)
{
    std::vector<std::string> out;
    size_t start = 0;
    for (size_t i = 0; i <= s.size(); i++)
    {
        if (i == s.size() || s[i] == '\n')
        {
            std::string line = s.substr(start, i - start);
            if (!line.empty() && line.back() == '\r') line.pop_back();
            out.push_back(line);
            start = i + 1;
        }
    }
    // 末尾换行会产生一个多余空行，去掉（避免 diff 里多出空行）
    if (out.size() > 1 && out.back().empty() && !s.empty() && s.back() == '\n')
        out.pop_back();
    return out;
}

// 生成面向"确认页展示"的 diff 预览（截断到 maxBytes 字节）。
// 用最简单的 LCS 差异算法——文件通常不大，够用且不引入依赖。
std::string buildDiffPreview(const std::string &oldText, const std::string &newText, size_t maxBytes)
{
    std::vector<std::string> a = splitLines(oldText);
    std::vector<std::string> b = splitLines(newText);

    // LCS 表（按 (n+1)*(m+1) 大小动态分配）
    size_t n = a.size(), m = b.size();
    // 防御：超大文件跳过精细 diff，退化为简单预览
    if (n * m > 4000000)
    {
        return "[改动较大，diff 已省略]\n新内容共 " + std::to_string(m) + " 行";
    }

    std::vector<uint32_t> dp((n + 1) * (m + 1), 0);
    auto at = [&](size_t i, size_t j) -> uint32_t & { return dp[i * (m + 1) + j]; };
    for (size_t i = n; i-- > 0;)
        for (size_t j = m; j-- > 0;)
            at(i, j) = (a[i] == b[j]) ? at(i + 1, j + 1) + 1
                                      : (at(i + 1, j) > at(i, j + 1) ? at(i + 1, j) : at(i, j + 1));

    std::string out;
    out.reserve(4096);
    size_t i = 0, j = 0;
    int context = 0;
    auto emit = [&](char tag, const std::string &line) -> bool {
        // 与上一行同类型时只补行，不重复打标签（紧凑显示连续增删）
        if (tag == ' ' && context > 0) { context--; }
        std::string lineOut(1, tag);
        lineOut += line;
        lineOut += '\n';
        if (out.size() + lineOut.size() > maxBytes)
        {
            out += "...[diff 过长已截断]\n";
            return false;
        }
        out += lineOut;
        return true;
    };

    while (i < n && j < m)
    {
        if (a[i] == b[j])
        {
            if (!emit(' ', a[i])) return out;
            i++; j++;
        }
        else if (at(i + 1, j) >= at(i, j + 1))
        {
            if (!emit('-', a[i])) return out;
            context = 2; // 删除后保留 2 行上下文
            i++;
        }
        else
        {
            if (!emit('+', b[j])) return out;
            context = 2;
            j++;
        }
    }
    while (i < n) { if (!emit('-', a[i])) return out; i++; }
    while (j < m) { if (!emit('+', b[j])) return out; j++; }

    if (out.empty()) out = "(无变化)";
    return out;
}

} // namespace

std::string DeepSeekWorker::readFile(const std::string &path, long maxBytes) const
{
    long cap = maxBytes;
    if (cap <= 0) cap = 262144;      // 默认 256KB
    if (cap > 4194304) cap = 4194304; // 上限 4MB

    FILE *f = fopen(path.c_str(), "rb");
    if (f == nullptr)
        return "{\"ok\":false,\"error\":\"文件不存在或无法打开\"}";

    // 先探大小，便于提示"被截断"
    fseek(f, 0, SEEK_END);
    long total = ftell(f);
    fseek(f, 0, SEEK_SET);

    std::string content;
    char buf[8192];
    size_t got = 0;
    while (got < (size_t)cap)
    {
        size_t want = sizeof buf;
        if ((size_t)cap - got < want) want = (size_t)cap - got;
        size_t n = fread(buf, 1, want, f);
        if (n == 0) break;
        content.append(buf, n);
        got += n;
    }
    fclose(f);

    bool truncated = (total > (long)got);
    std::string json = "{\"ok\":true,\"content\":\"" + JVal::escape(content) +
                       "\",\"size\":" + std::to_string(total) +
                       ",\"truncated\":" + (truncated ? "true" : "false") + "}";
    return json;
}

std::string DeepSeekWorker::writeFile(const std::string &path, const std::string &content) const
{
    // 读旧内容（用于 diff 预览；不存在则为空 → 视为新建）
    std::string oldText;
    bool existed = false;
    {
        FILE *f = fopen(path.c_str(), "rb");
        if (f != nullptr)
        {
            existed = true;
            char buf[8192];
            size_t n;
            // diff 预览不需要全文，读前 512KB 足够
            size_t total = 0;
            while ((n = fread(buf, 1, sizeof buf, f)) > 0 && total < 524288)
            {
                oldText.append(buf, n);
                total += n;
            }
            fclose(f);
        }
    }

    mkdirsFor(path);

    // 先写临时文件再 rename：避免写一半被杀导致文件损坏
    std::string tmp = path + ".tmp";
    FILE *f = fopen(tmp.c_str(), "wb");
    if (f == nullptr)
        return "{\"ok\":false,\"error\":\"无法写入（目录不存在或无权限）\"}";
    size_t written = fwrite(content.data(), 1, content.size(), f);
    int flushRc = fflush(f);
    int closeRc = fclose(f);
    if (written != content.size() || flushRc != 0 || closeRc != 0)
    {
        ::remove(tmp.c_str());
        return "{\"ok\":false,\"error\":\"写入失败（磁盘空间或权限不足）\"}";
    }
    if (::rename(tmp.c_str(), path.c_str()) != 0)
    {
        ::remove(tmp.c_str());
        return "{\"ok\":false,\"error\":\"保存失败（rename 失败）\"}";
    }

    std::string diff = existed ? buildDiffPreview(oldText, content, 4096)
                               : ("(新建文件，共 " + std::to_string(splitLines(content).size()) + " 行)");

    return "{\"ok\":true,\"bytes\":" + std::to_string(content.size()) +
           ",\"created\":" + (existed ? "false" : "true") +
           ",\"diff\":\"" + JVal::escape(diff) + "\"}";
}

// ---------------------------------------------------------------------------
// 执行 shell 命令
//
// 设备无 `timeout` 命令，因此这里用 fork + pipe + poll 自己实现超时：
//   子进程：pipe 到 stdout/stderr（合并），execl("/bin/sh","sh","-c",cmd)
//   父进程：poll 读，超过 deadline 就 kill(SIGKILL) 整组，再 waitpid 回收
// 输出上限 256KB（防大输出打爆内存）；超限即停读并标记 truncated。
// ---------------------------------------------------------------------------
std::string DeepSeekWorker::execCommand(const std::string &cmd, int timeoutMs) const
{
    const size_t kMaxOutput = 262144; // 256KB

    int tmo = timeoutMs;
    if (tmo <= 0) tmo = 15000;
    if (tmo > 300000) tmo = 300000; // 上限 5 分钟，防止 AI 传超大值挂死

    int pipefd[2];
    if (pipe(pipefd) != 0)
        return "{\"code\":-1,\"output\":\"创建管道失败\",\"timedOut\":false,\"truncated\":false}";

    pid_t pid = fork();
    if (pid < 0)
    {
        ::close(pipefd[0]);
        ::close(pipefd[1]);
        return "{\"code\":-1,\"output\":\"fork 失败\",\"timedOut\":false,\"truncated\":false}";
    }

    if (pid == 0)
    {
        // ---- 子进程 ----
        // 新进程组：超时时可整组 kill，避免杀掉父进程自己
        setpgid(0, 0);
        ::close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        dup2(pipefd[1], STDERR_FILENO); // stderr 合并进同一管道
        ::close(pipefd[1]);
        // stdin 重定向到 /dev/null：防止命令（如 cat）等待输入挂住
        int devnull = open("/dev/null", O_RDONLY);
        if (devnull >= 0)
        {
            dup2(devnull, STDIN_FILENO);
            if (devnull > STDIN_FILENO) ::close(devnull);
        }
        execl("/bin/sh", "sh", "-c", cmd.c_str(), (char *)nullptr);
        _exit(127); // exec 失败
    }

    // ---- 父进程 ----
    setpgid(pid, pid); // 与子进程竞争设置，任一成功即可
    ::close(pipefd[1]);

    std::string out;
    bool timedOut = false;
    bool truncated = false;
    uint64_t deadline = nowMs() + (uint64_t)tmo;
    bool eof = false;

    while (!eof)
    {
        int64_t remain = (int64_t)(deadline - nowMs());
        if (remain <= 0)
        {
            timedOut = true;
            break;
        }
        struct pollfd pfd;
        pfd.fd = pipefd[0];
        pfd.events = POLLIN;
        int pr = poll(&pfd, 1, (int)(remain > 200 ? 200 : remain));
        if (pr < 0)
        {
            if (errno == EINTR) continue;
            break;
        }
        if (pr == 0) continue; // 超时片，回循环顶部检查 deadline

        char buf[4096];
        ssize_t n = ::read(pipefd[0], buf, sizeof buf);
        if (n > 0)
        {
            if (out.size() + (size_t)n > kMaxOutput)
            {
                out.append(buf, kMaxOutput - out.size());
                truncated = true;
                break; // 不再读，直接进入清理
            }
            out.append(buf, (size_t)n);
        }
        else if (n == 0)
        {
            eof = true; // 写端关闭
        }
        else if (errno != EINTR)
        {
            break;
        }
    }

    // 超时/截断：终止整个进程组（子进程可能还开着孙进程）
    int status = 0;
    if (timedOut || truncated)
    {
        kill(-pid, SIGKILL);
        kill(pid, SIGKILL);
    }
    // 回收：必须 waitpid，否则留僵尸进程。
    // 注意顺序——waitpid 必须在 close(pipefd[0]) 之前、且主循环已读到 EOF 或
    // 已决定放弃读取；反过来（先 close 再 read）会读到无效 fd。
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) { /* 重试 */ }
    ::close(pipefd[0]);

    // 退出码：正常退出用 exit code；被信号杀死用 128+signal
    int code = -1;
    if (WIFEXITED(status))
        code = WEXITSTATUS(status);
    else if (WIFSIGNALED(status))
        code = 128 + WTERMSIG(status);

    // 组装 JSON（输出需转义）
    std::string note;
    if (timedOut)
        note = "\\n[命令超时（" + std::to_string(tmo / 1000) + " 秒），已强制终止]";
    else if (truncated)
        note = "\\n[输出过长，已截断]";

    std::string json = "{\"code\":" + std::to_string(code) +
                       ",\"output\":\"" + JVal::escape(out) + note +
                       "\",\"timedOut\":" + (timedOut ? "true" : "false") +
                       ",\"truncated\":" + (truncated ? "true" : "false") + "}";
    return json;
}

// 诊断日志（见头文件说明）：追加写入，失败静默，绝不抛
std::string DeepSeekWorker::debugLog(const std::string &text) const
{
    const char *path = "/tmp/deepseek_diag.log";
    FILE *f = fopen(path, "ab");
    if (f == nullptr) return "{\"ok\":false,\"error\":\"open failed\"}";

    // 时间戳（设备本地时间，便于与 adb 侧操作对齐）
    time_t now = time(nullptr);
    struct tm tmv;
    memset(&tmv, 0, sizeof tmv);
    localtime_r(&now, &tmv);
    char stamp[32];
    strftime(stamp, sizeof stamp, "%m-%d %H:%M:%S", &tmv);

    fprintf(f, "[%s] %s\n", stamp, text.c_str());
    fflush(f);
    fclose(f);
    return "{\"ok\":true}";
}

std::string DeepSeekWorker::chat(const std::string &requestJson) const
{
    // ---- 解析请求 ----
    JVal root = JVal::parse(requestJson);
    if (root.type != JVal::OBJ)
        return buildErr("invalid_request", "请求参数不是 JSON 对象", 0);

    std::string apiBaseUrl = strField(root, "api_base_url", "https://api.deepseek.com/v1");
    std::string apiKey = strField(root, "api_key", "");
    std::string model = strField(root, "model", "deepseek-chat");
    const JVal *tv = root.find("timeout_ms");
    int timeoutMs = 30000;
    if (tv != nullptr && tv->type == JVal::NUM && tv->num > 0 && tv->num < 600000)
        timeoutMs = (int)tv->num;

    if (apiKey.empty())
        return buildErr("invalid_request", "缺少 API Key", 0);

    // ---- URL 解析 + 拼接 /chat/completions ----
    UrlParts url;
    if (!parseUrl(apiBaseUrl, url))
        return buildErr("invalid_request", "api_base_url 无效（仅支持 https://host[:port][/path]）", 0);

    std::string basePath = url.path;
    while (basePath.size() > 1 && basePath.back() == '/') basePath.pop_back();
    std::string path = basePath + "/chat/completions";

    // ---- 重建请求体（只保留 DeepSeek API 认识的字段，强制非流式） ----
    JVal payload = JVal::mkObj();
    payload.obj.push_back({"model", JVal::mkStr(model)});
    const JVal *msgs = root.find("messages");
    if (msgs == nullptr || msgs->type != JVal::ARR)
        return buildErr("invalid_request", "缺少 messages 数组", 0);
    payload.obj.push_back({"messages", *msgs});
    const JVal *mt = root.find("max_tokens");
    if (mt != nullptr && mt->type == JVal::NUM) payload.obj.push_back({"max_tokens", *mt});
    // function calling：tools / tool_choice 原样透传（是否启用由 JS 侧决定）
    const JVal *tools = root.find("tools");
    if (tools != nullptr && tools->type == JVal::ARR && !tools->arr.empty())
        payload.obj.push_back({"tools", *tools});
    const JVal *tchoice = root.find("tool_choice");
    if (tchoice != nullptr) payload.obj.push_back({"tool_choice", *tchoice});
    payload.obj.push_back({"stream", JVal::mkBool(false)});
    std::string payloadJson = payload.dump();

    // ---- HTTPS 请求 ----
    TlsClient tls(timeoutMs);
    std::string err;

    if (!tls.open(url.host, url.port, err))
        return buildErr("unavailable", err, 0);
    if (!tls.handshake(err))
        return buildErr("unavailable", err, 0);

    HttpResp resp;
    if (!httpPost(tls, url.host, url.port, path, apiKey, payloadJson, resp, err))
    {
        if (err == "timeout")
            return buildErr("timeout", "请求超时", 0);
        return buildErr("unavailable", err, 0);
    }

    // ---- 解析响应 ----
    JVal body = JVal::parse(resp.body);
    if (resp.status >= 200 && resp.status < 300)
    {
        // 模型要求调用工具：优先返回 tool_calls（可能同时带 content 说明）
        std::string toolCalls;
        if (extractToolCalls(body, toolCalls))
        {
            std::string content;
            extractContent(body, content);
            return "{\"ok\":true,\"tool_calls\":" + toolCalls +
                   ",\"content\":\"" + JVal::escape(content) + "\"}";
        }
        std::string content;
        if (extractContent(body, content) && !content.empty())
            return buildOk(content);

        std::string emsg = "响应缺少 choices[0].message.content";
        extractError(body, emsg);
        return buildErr("bad_response", emsg, resp.status);
    }

    std::string emsg = statusText(resp.status);
    extractError(body, emsg);
    return buildErr(statusCode(resp.status), emsg, resp.status);
}

// 与 chat() 同构，但走 SSE 流式：增量正文通过 onDelta 抛出（工作线程），
// 返回值仍是 {"ok":true,"content":全文} / {"ok":false,...}。
std::string DeepSeekWorker::chatStream(const std::string &requestJson, const DeltaFn &onDelta) const
{
    // ---- 解析请求（与 chat 一致）----
    JVal root = JVal::parse(requestJson);
    if (root.type != JVal::OBJ)
        return buildErr("invalid_request", "请求参数不是 JSON 对象", 0);

    std::string apiBaseUrl = strField(root, "api_base_url", "https://api.deepseek.com/v1");
    std::string apiKey = strField(root, "api_key", "");
    std::string model = strField(root, "model", "deepseek-chat");
    const JVal *tv = root.find("timeout_ms");
    int timeoutMs = 30000;
    if (tv != nullptr && tv->type == JVal::NUM && tv->num > 0 && tv->num < 600000)
        timeoutMs = (int)tv->num;

    if (apiKey.empty())
        return buildErr("invalid_request", "缺少 API Key", 0);

    UrlParts url;
    if (!parseUrl(apiBaseUrl, url))
        return buildErr("invalid_request", "api_base_url 无效（仅支持 https://host[:port][/path]）", 0);

    std::string basePath = url.path;
    while (basePath.size() > 1 && basePath.back() == '/') basePath.pop_back();
    std::string path = basePath + "/chat/completions";

    // ---- 重建请求体，强制 stream:true ----
    JVal payload = JVal::mkObj();
    payload.obj.push_back({"model", JVal::mkStr(model)});
    const JVal *msgs = root.find("messages");
    if (msgs == nullptr || msgs->type != JVal::ARR)
        return buildErr("invalid_request", "缺少 messages 数组", 0);
    payload.obj.push_back({"messages", *msgs});
    const JVal *mt = root.find("max_tokens");
    if (mt != nullptr && mt->type == JVal::NUM) payload.obj.push_back({"max_tokens", *mt});
    payload.obj.push_back({"stream", JVal::mkBool(true)});
    std::string payloadJson = payload.dump();

    // ---- HTTPS ----
    TlsClient tls(timeoutMs);
    std::string err;
    if (!tls.open(url.host, url.port, err))
        return buildErr("unavailable", err, 0);
    if (!tls.handshake(err))
        return buildErr("unavailable", err, 0);

    int status = 0;
    std::string fullText, bodyErr;
    if (!httpPostStream(tls, url.host, url.port, path, apiKey, payloadJson, onDelta,
                        status, fullText, bodyErr))
    {
        if (bodyErr == "timeout") return buildErr("timeout", "请求超时", 0);
        return buildErr("unavailable", bodyErr.empty() ? "流式读取失败" : bodyErr, 0);
    }

    if (status >= 200 && status < 300)
    {
        if (fullText.empty())
            return buildErr("bad_response", "流式响应没有正文", status);
        return buildOk(fullText);
    }

    // 非 2xx：fullText 是普通 JSON 错误体
    std::string emsg = statusText(status);
    JVal body = JVal::parse(fullText);
    extractError(body, emsg);
    return buildErr(statusCode(status), emsg, status);
}
