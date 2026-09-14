"""Sample python module."""

MAX_CONNECTIONS = 8


class Server:
    def __init__(self, port):
        self.port = port

    def start(self):
        return self._listen(self.port)

    def _listen(self, port):
        return f"listening on {port}"


def helper(value):
    return value * MAX_CONNECTIONS


def main():
    server = Server(8080)
    return helper(1) + server.start()
