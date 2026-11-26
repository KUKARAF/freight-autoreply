"""The deterministic layer. First matching branch wins; the LLM only runs where a branch says so."""

import re
import unicodedata
from collections.abc import Awaitable, Callable

from .models import Branch, DecideRequest, Decision, Flow


def fold(text: str) -> str:
    """Lower-case without accents, so "dostepne" matches "dostępne". ł has no decomposition."""
    decomposed = unicodedata.normalize("NFD", text.lower())
    return "".join(c for c in decomposed if not unicodedata.combining(c)).replace("ł", "l")


def keywords_match(keywords: str, text: str) -> bool:
    """Comma separated; each matches at the start of a word, so "cen" covers "cena" and "cenę"."""
    haystack = fold(text)
    words = (fold(k.strip()) for k in keywords.split(","))
    return any(re.search(rf"(?<![^\W_]){re.escape(w)}", haystack) for w in words if w)


def find_branch(flow: Flow, msg: DecideRequest) -> Branch | None:
    for b in flow.branches:
        if (
            b.enabled
            and b.platform in ("any", msg.platform)
            and (msg.isFirst or not b.first_only)
            and (b.match == "any" or keywords_match(b.keywords, msg.text))
        ):
            return b
    return None


def render(template: str, msg: DecideRequest) -> tuple[str, list[str]]:
    """Fill {placeholders}; returns the text and the names that had no value."""
    values = {
        "senderName": msg.senderName,
        "firstName": msg.senderFirstName,
        "company": msg.context.senderCompany,
        "loadingCity": msg.context.loadingCity,
        "unloadingCity": msg.context.unloadingCity,
    }
    missing: list[str] = []

    def substitute(m: re.Match) -> str:
        if values.get(m[1]):
            return values[m[1]]
        missing.append(m[1])
        return m[0]

    return re.sub(r"\{(\w+)\}", substitute, template).strip(), missing


# (flow, extra instructions, message) -> reply text, or None when the model declines
LlmReply = Callable[[Flow, str, DecideRequest], Awaitable[str | None]]


async def decide(flow: Flow, msg: DecideRequest, llm: LlmReply) -> Decision:
    branch = find_branch(flow, msg)
    if branch:
        source = f"rule: {branch.name or branch.id}"
        action, reply, auto = branch.action, branch.reply, branch.auto_send
        instructions = branch.instructions
    else:
        source = "otherwise"
        action, reply, auto = flow.otherwise.action, flow.otherwise.reply, flow.otherwise.auto_send
        instructions = ""

    if action == "ignore":
        return Decision(action="ignore", source=source)
    if action == "none":
        return Decision(action="none", source=source)
    if action == "template":
        text, missing = render(reply, msg)
        if not text:
            return Decision(action="none", source=source, note="the reply text is empty")
        note = f"no value for {', '.join(missing)}" if missing else ""
        return Decision(action="reply", text=text, autoSend=auto and not missing, source=source, note=note)

    text = await llm(flow, instructions, msg)
    if not text:
        return Decision(action="none", source=f"{source} (AI)", note="the AI chose not to answer")
    # People must be told when they are talking to AI, so unreviewed AI text always says so.
    if auto:
        if not flow.disclosure.strip():
            return Decision(
                action="reply", text=text, source=f"{source} (AI)", note="add an AI notice to auto-send"
            )
        text = f"{text}\n{flow.disclosure.strip()}"
    return Decision(action="reply", text=text, autoSend=auto, source=f"{source} (AI)")
