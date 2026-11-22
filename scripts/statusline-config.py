"""Merge a native footer binding. Input and output are private stdio JSON."""
import copy
import json
import re
import shlex
import sys
import tomllib


def merge(host, source, script, legacy, home, enabled):
    command = "python3 " + shlex.quote(script)
    absolute_legacy = home + legacy[1:]
    old_commands = {legacy, absolute_legacy, command}
    if host in ("claude", "agy"):
        obj = json.loads(source or "{}")
        binding = obj.get("statusLine", {})
        if not isinstance(binding, dict):
            return source
        prior = binding.get("command")
        if enabled and (not binding or prior in old_commands and binding.get("type") == "command"):
            obj["statusLine"] = {**binding, "type": "command", "command": command}
        elif not enabled and prior == command:
            del obj["statusLine"]
        else:
            return source
        return source if obj == json.loads(source or "{}") else json.dumps(obj, indent=2, ensure_ascii=False) + "\n"

    doc = tomllib.loads(source)
    expected = copy.deepcopy(doc)
    if host == "grok":
        table = doc.get("ui", {}).get("status_line", {})
        if table and (table.get("type") != "command" or table.get("command") not in old_commands):
            return source
        if not enabled and table.get("command") != command:
            return source
        changes = {"ui.status_line": {"type": "command", "command": command}}
    else:
        provider = {"server": "usage-statusline", "tool": "statusline"}
        server = doc.get("mcp_servers", {}).get("usage-statusline", {})
        binding = doc.get("tui", {}).get("status_line_provider")
        args = ["-u", script]
        if server and (server.get("command") != "python3" or server.get("args") not in (args, ["-u", absolute_legacy])):
            return source
        if binding not in (None, provider) or (not enabled and server.get("args") != args):
            return source
        changes = {"mcp_servers.usage-statusline": {"command": "python3", "args": args},
                   "tui": {"status_line_provider": provider}}
        if enabled:
            changes["features"] = {"tui_extensions_statusline": True}
    original = source
    for table_name, fields in changes.items():
        table = expected
        for name in table_name.split("."):
            table = table.setdefault(name, {})
        for key, val in fields.items():
            if enabled and table.get(key) == val or not enabled and key not in table:
                continue
            header = re.search(r"(?m)^\s*\[" + re.escape(table_name) + r"\][ \t]*(?:#.*)?$", source)
            if not header:
                source = source.rstrip("\n") + "\n\n[" + table_name + "]\n"
                start = len(source)
            else:
                start = header.end()
            following = re.search(r"(?m)^\s*\[", source[start:])
            end = start + following.start() if following else len(source)
            chunk = source[start:end]
            line = re.compile(r"(?m)^[ \t]*" + re.escape(key) + r"[ \t]*=.*$")
            if enabled:
                value = ('{ server = "usage-statusline", tool = "statusline" }'
                         if isinstance(val, dict) else json.dumps(val, ensure_ascii=False))
                assignment = key + " = " + value
                chunk = line.sub(lambda _: assignment, chunk, count=1) if line.search(chunk) else "\n" + assignment + "\n" + chunk
                table[key] = val
            else:
                chunk = line.sub("", chunk, count=1)
                del table[key]
            source = source[:start] + chunk + source[end:]
        if not enabled and not table and "." in table_name:
            source = re.sub(r"(?m)^[ \t]*\[" + re.escape(table_name) + r"\][ \t]*(?:#.*)?$", "", source, count=1)
            parent, leaf = table_name.split(".")
            del expected[parent][leaf]
            if not expected[parent] and parent not in tomllib.loads(source):
                del expected[parent]
    if source != original and tomllib.loads(source) != expected:
        raise ValueError("Cannot safely edit native TOML layout")
    return source


if __name__ == "__main__":
    print(json.dumps(merge(**json.load(sys.stdin))))
