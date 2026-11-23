"""Merge a native footer binding. Input and output are private stdio JSON."""
import copy
import json
import re
import shlex
import sys
import tomllib


def merge(host, source, script, legacy, home, enabled):
    script_path = shlex.quote(script)
    command = "python3 -B " + script_path
    absolute_legacy = home + legacy[1:]
    owned_commands = (command, "python3 " + script_path)
    known_commands = (*owned_commands, legacy, absolute_legacy)
    if host in ("claude", "agy"):
        obj = json.loads(source or "{}")
        binding = obj.get("statusLine", {})
        if not isinstance(binding, dict):
            return source
        prior = binding.get("command")
        if enabled and ((prior is None and "type" not in binding)
                        or prior in known_commands and binding.get("type") == "command"):
            obj["statusLine"] = {**binding, "type": "command", "command": command}
        elif not enabled and prior in owned_commands and binding.get("type") == "command":
            del binding["command"]
            del binding["type"]
            if not binding:
                del obj["statusLine"]
        else:
            return source
        return source if obj == json.loads(source or "{}") else json.dumps(obj, indent=2, ensure_ascii=False) + "\n"

    doc = tomllib.loads(source)
    expected = copy.deepcopy(doc)
    if host == "grok":
        table = doc.get("ui", {}).get("status_line", {})
        if table and (table.get("type") != "command" or table.get("command") not in known_commands):
            return source
        if not enabled and table.get("command") not in owned_commands:
            return source
        changes = {"ui.status_line": {"type": "command", "command": command}}
    else:
        provider = {"server": "usage-statusline", "tool": "statusline"}
        server = doc.get("mcp_servers", {}).get("usage-statusline", {})
        binding = doc.get("tui", {}).get("status_line_provider")
        args = ["-B", "-u", script]
        owned_args = (args, ["-u", script])
        known_args = (*owned_args, ["-u", absolute_legacy])
        prior_args = server.get("args")
        custom_provider = binding not in (None, provider)
        if server and (server.get("command") != "python3" or prior_args not in known_args):
            return source
        if (not enabled or custom_provider) and prior_args not in owned_args:
            return source
        if not enabled and custom_provider and isinstance(binding, dict) and binding.get("server") == provider["server"]:
            return source
        changes = {"mcp_servers.usage-statusline": {"command": "python3", "args": args}}
        if not custom_provider and (enabled or binding is not None):
            changes["tui"] = {"status_line_provider": provider}
        if enabled and not custom_provider:
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
            match = line.search(chunk)
            if match:
                stop = match.end()
                for _ in range(128):
                    try:
                        tomllib.loads(chunk[match.start():stop])
                        break
                    except tomllib.TOMLDecodeError:
                        if stop == len(chunk):
                            return original
                        newline = chunk.find("\n", stop + 1)
                        stop = len(chunk) if newline == -1 else newline
                else:
                    return original
            if enabled:
                value = ('{ server = "usage-statusline", tool = "statusline" }'
                         if isinstance(val, dict) else json.dumps(val, ensure_ascii=False))
                assignment = key + " = " + value
                chunk = (chunk[:match.start()] + assignment + chunk[stop:] if match
                         else "\n" + assignment + "\n" + chunk)
                table[key] = val
            else:
                if match:
                    chunk = chunk[:match.start()] + chunk[stop:]
                del table[key]
            source = source[:start] + chunk + source[end:]
        if not enabled and not table and "." in table_name:
            source = re.sub(r"(?m)^[ \t]*\[" + re.escape(table_name) + r"\][ \t]*(?:#.*)?$", "", source, count=1)
            parent, leaf = table_name.split(".")
            del expected[parent][leaf]
            if not expected[parent] and not re.search(r"(?m)^\s*\[\s*" + re.escape(parent) + r"(?:\s*\]|\s*\.)", source):
                del expected[parent]
    try:
        if source != original and tomllib.loads(source) != expected:
            return original
    except tomllib.TOMLDecodeError:
        return original
    return source


if __name__ == "__main__":
    print(json.dumps(merge(**json.load(sys.stdin))))
