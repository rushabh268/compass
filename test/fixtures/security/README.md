# Security Fixtures

This directory is reserved for synthetic negative-test fixtures used by the
enforced-mode containment acceptance suite. Fixtures must never contain live credentials.
Do not add production tokens, private keys, session cookies, or copied user data.

Future fixtures will cover attempts by an admitted agent to:

- read publisher credentials;
- connect directly to publication endpoints; and
- forge or replay approval through the Unix socket.

Expected scanner output records only fixture paths and rule IDs, never matched
values. The suite becomes an enforced-mode gate only after the sandbox,
gateways, publisher, and authenticated supervisor channel exist.
