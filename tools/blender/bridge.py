import socket, json, sys
def call(cmd, params=None, timeout=60):
    s = socket.create_connection(("127.0.0.1", 9876), timeout=timeout)
    s.sendall(json.dumps({"type": cmd, "params": params or {}}).encode())
    buf = b""
    while True:
        chunk = s.recv(65536)
        if not chunk: break
        buf += chunk
        try:
            out = json.loads(buf.decode()); break
        except Exception: continue
    s.close(); return out
if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "exec":
        cmd, params = "execute_code", {"code": open(sys.argv[2]).read()}
    else:
        params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    print(json.dumps(call(cmd, params), indent=1)[:4000])
