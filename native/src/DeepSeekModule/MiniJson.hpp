// ============================================================================
//  MiniJson —— 极简 JSON（仅覆盖 DeepSeek 场景：对象/数组/字符串/数字/布尔/null）
//  header-only，无外部依赖。用于：
//    1) 解析 native 侧收到的请求 JSON（api_base_url / api_key / model / messages ...）
//    2) 解析 DeepSeek API 响应，提取 choices[0].message.content 与 error.message
//    3) 重建请求体 + 构造返回 JSON 字符串（含转义）
// ============================================================================

#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

struct JVal
{
    enum Type { NUL, BOOL, NUM, STR, ARR, OBJ };

    Type type = NUL;
    bool b = false;
    double num = 0;
    std::string str;
    std::vector<JVal> arr;
    std::vector<std::pair<std::string, JVal>> obj;

    // ---------- 构造辅助 ----------
    static JVal mkNull() { return JVal(); }
    static JVal mkBool(bool v) { JVal j; j.type = BOOL; j.b = v; return j; }
    static JVal mkNum(double v) { JVal j; j.type = NUM; j.num = v; return j; }
    static JVal mkStr(const std::string &v) { JVal j; j.type = STR; j.str = v; return j; }
    static JVal mkArr() { JVal j; j.type = ARR; return j; }
    static JVal mkObj() { JVal j; j.type = OBJ; return j; }

    // ---------- 访问辅助 ----------
    const JVal *find(const char *key) const
    {
        if (type != OBJ) return nullptr;
        for (const auto &kv : obj)
            if (kv.first == key) return &kv.second;
        return nullptr;
    }
    const JVal *at(size_t i) const
    {
        return (type == ARR && i < arr.size()) ? &arr[i] : nullptr;
    }

    // ---------- 序列化 ----------
    std::string dump() const
    {
        std::string s;
        dumpInto(s);
        return s;
    }

    static std::string escape(const std::string &s)
    {
        std::string o;
        appendEscaped(o, s);
        return o;
    }

    // ---------- 解析：失败返回 NUL ----------
    static JVal parse(const std::string &text)
    {
        const char *p = text.c_str();
        skipWs(p);
        JVal v;
        if (parseValue(p, v))
        {
            skipWs(p);
            if (*p == '\0') return v;
        }
        return JVal();
    }

private:
    static void skipWs(const char *&p)
    {
        while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') ++p;
    }

    static void appendEscaped(std::string &out, const std::string &s)
    {
        for (unsigned char c : s)
        {
            switch (c)
            {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            default:
                if (c < 0x20)
                {
                    char buf[8];
                    snprintf(buf, sizeof buf, "\\u%04x", (unsigned)c);
                    out += buf;
                }
                else
                {
                    out.push_back((char)c);
                }
            }
        }
    }

    void dumpInto(std::string &s) const
    {
        switch (type)
        {
        case NUL: s += "null"; break;
        case BOOL: s += b ? "true" : "false"; break;
        case NUM:
        {
            char buf[40];
            snprintf(buf, sizeof buf, "%g", num);
            s += buf;
            break;
        }
        case STR:
            s += '"';
            appendEscaped(s, str);
            s += '"';
            break;
        case ARR:
        {
            s += '[';
            for (size_t i = 0; i < arr.size(); ++i)
            {
                if (i) s += ',';
                arr[i].dumpInto(s);
            }
            s += ']';
            break;
        }
        case OBJ:
        {
            s += '{';
            for (size_t i = 0; i < obj.size(); ++i)
            {
                if (i) s += ',';
                s += '"';
                appendEscaped(s, obj[i].first);
                s += "\":";
                obj[i].second.dumpInto(s);
            }
            s += '}';
            break;
        }
        }
    }

    // ---------- 解析器 ----------
    static bool parseHex4(const char *&p, uint32_t &cp)
    {
        cp = 0;
        for (int i = 0; i < 4; ++i)
        {
            char c = *p;
            uint32_t v;
            if (c >= '0' && c <= '9') v = (uint32_t)(c - '0');
            else if (c >= 'a' && c <= 'f') v = (uint32_t)(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v = (uint32_t)(c - 'A' + 10);
            else return false;
            cp = (cp << 4) | v;
            ++p;
        }
        return true;
    }

    static void appendUtf8(std::string &out, uint32_t cp)
    {
        if (cp < 0x80)
        {
            out.push_back((char)cp);
        }
        else if (cp < 0x800)
        {
            out.push_back((char)(0xC0 | (cp >> 6)));
            out.push_back((char)(0x80 | (cp & 0x3F)));
        }
        else if (cp < 0x10000)
        {
            out.push_back((char)(0xE0 | (cp >> 12)));
            out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back((char)(0x80 | (cp & 0x3F)));
        }
        else
        {
            out.push_back((char)(0xF0 | (cp >> 18)));
            out.push_back((char)(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back((char)(0x80 | (cp & 0x3F)));
        }
    }

    static bool parseStringRaw(const char *&p, std::string &out)
    {
        // p 已越过开引号
        while (*p && *p != '"')
        {
            char c = *p++;
            if (c == '\\')
            {
                char e = *p++;
                switch (e)
                {
                case '"': out.push_back('"'); break;
                case '\\': out.push_back('\\'); break;
                case '/': out.push_back('/'); break;
                case 'b': out.push_back('\b'); break;
                case 'f': out.push_back('\f'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                case 'u':
                {
                    uint32_t cp = 0;
                    if (!parseHex4(p, cp)) return false;
                    if (cp >= 0xD800 && cp <= 0xDBFF)
                    {
                        // 高代理：尝试组合低代理
                        if (p[0] == '\\' && p[1] == 'u')
                        {
                            const char *save = p;
                            p += 2;
                            uint32_t lo = 0;
                            if (parseHex4(p, lo) && lo >= 0xDC00 && lo <= 0xDFFF)
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            else
                                p = save;
                        }
                    }
                    else if (cp >= 0xDC00 && cp <= 0xDFFF)
                    {
                        cp = 0xFFFD; // 孤立低代理
                    }
                    appendUtf8(out, cp);
                    break;
                }
                default: return false;
                }
            }
            else
            {
                out.push_back(c);
            }
        }
        if (*p != '"') return false;
        ++p;
        return true;
    }

    static bool parseNumberRaw(const char *&p, double &v)
    {
        const char *start = p;
        if (*p == '-') ++p;
        if (*p < '0' || *p > '9') return false;
        while (*p >= '0' && *p <= '9') ++p;
        if (*p == '.')
        {
            ++p;
            if (*p < '0' || *p > '9') return false;
            while (*p >= '0' && *p <= '9') ++p;
        }
        if (*p == 'e' || *p == 'E')
        {
            ++p;
            if (*p == '+' || *p == '-') ++p;
            if (*p < '0' || *p > '9') return false;
            while (*p >= '0' && *p <= '9') ++p;
        }
        std::string tmp(start, p);
        v = strtod(tmp.c_str(), nullptr);
        return true;
    }

    static bool parseValue(const char *&p, JVal &out)
    {
        skipWs(p);
        char c = *p;
        switch (c)
        {
        case '{': return parseObjectLiteral(p, out);
        case '[': return parseArrayLiteral(p, out);
        case '"':
        {
            ++p;
            out.type = STR;
            return parseStringRaw(p, out.str);
        }
        case 't':
            if (strncmp(p, "true", 4) == 0) { p += 4; out.type = BOOL; out.b = true; return true; }
            return false;
        case 'f':
            if (strncmp(p, "false", 5) == 0) { p += 5; out.type = BOOL; out.b = false; return true; }
            return false;
        case 'n':
            if (strncmp(p, "null", 4) == 0) { p += 4; out.type = NUL; return true; }
            return false;
        default:
        {
            double v = 0;
            if (parseNumberRaw(p, v)) { out.type = NUM; out.num = v; return true; }
            return false;
        }
        }
    }

    static bool parseArrayLiteral(const char *&p, JVal &out)
    {
        ++p; // '['
        out.type = ARR;
        skipWs(p);
        if (*p == ']') { ++p; return true; }
        for (;;)
        {
            JVal item;
            if (!parseValue(p, item)) return false;
            out.arr.push_back(item);
            skipWs(p);
            char c = *p;
            if (c == ',') { ++p; continue; }
            if (c == ']') { ++p; return true; }
            return false;
        }
    }

    static bool parseObjectLiteral(const char *&p, JVal &out)
    {
        ++p; // '{'
        out.type = OBJ;
        skipWs(p);
        if (*p == '}') { ++p; return true; }
        for (;;)
        {
            skipWs(p);
            if (*p != '"') return false;
            ++p;
            std::string key;
            if (!parseStringRaw(p, key)) return false;
            skipWs(p);
            if (*p != ':') return false;
            ++p;
            JVal value;
            if (!parseValue(p, value)) return false;
            out.obj.push_back({key, value});
            skipWs(p);
            char c = *p;
            if (c == ',') { ++p; continue; }
            if (c == '}') { ++p; return true; }
            return false;
        }
    }
};