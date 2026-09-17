"""Northstar SaaS — /login handler.

A baseline scan already ran. This response does not set
Content-Security-Policy. The agent writes the fix elsewhere.
"""


def login_headers() -> dict[str, str]:
    return {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
    }


def login_body() -> str:
    return (
        "<!doctype html><html><body>"
        "<form method='post' action='/login'>"
        "<label>Email <input name='email' type='email'></label>"
        "<label>Password <input name='password' type='password'></label>"
        "<button type='submit'>Sign in</button>"
        "</form></body></html>"
    )


def handle_login() -> dict:
    return {
        "status": 200,
        "path": "/login",
        "headers": login_headers(),
        "body": login_body(),
    }
