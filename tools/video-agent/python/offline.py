"""Fail closed if an inference dependency attempts a network connection.

This is a Python-level guard, not a substitute for an OS firewall/sandbox.
"""
import os
import socket


def disable_network():
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", DO_NOT_TRACK="1")

    def blocked(*_args, **_kwargs):
        raise RuntimeError("Network disabled during inference. Run setup_models.sh while online first.")

    socket.create_connection = blocked
    socket.socket.connect = blocked
    socket.socket.connect_ex = blocked
