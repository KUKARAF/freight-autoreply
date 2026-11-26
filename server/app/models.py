"""The reply flow a user edits: IF branch ELIF branch ... ELSE otherwise."""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

DEFAULT_PROMPT = (
    "You assist a freight forwarding company. Answer briefly and politely. "
    "If you do not know something, say that a colleague will confirm shortly."
)
DEFAULT_DISCLOSURE = "(automatic AI reply / automatyczna odpowiedź AI)"


class Branch(BaseModel):
    id: str = Field(max_length=40)
    name: str = Field(default="", max_length=80)
    enabled: bool = True
    platform: Literal["any", "timocom", "transeu"] = "any"
    first_only: bool = False
    match: Literal["keywords", "any"] = "keywords"
    keywords: str = Field(default="", max_length=1000)
    action: Literal["template", "llm", "ignore"] = "template"
    reply: str = Field(default="", max_length=2000)
    instructions: str = Field(default="", max_length=2000)
    auto_send: bool = False


class Otherwise(BaseModel):
    action: Literal["none", "template", "llm"] = "none"
    reply: str = Field(default="", max_length=2000)
    auto_send: bool = False


class Flow(BaseModel):
    branches: list[Branch] = Field(default_factory=list, max_length=30)
    otherwise: Otherwise = Field(default_factory=Otherwise)
    prompt: str = Field(default=DEFAULT_PROMPT, max_length=4000)
    disclosure: str = Field(default=DEFAULT_DISCLOSURE, max_length=200)

    @model_validator(mode="after")
    def unique_ids(self):
        if len({b.id for b in self.branches}) != len(self.branches):
            raise ValueError("branch ids must be unique")
        return self


def default_flow() -> Flow:
    # Ships as "suggest": the app cannot know whether an offer is still open.
    return Flow(
        branches=[
            Branch(
                id="available",
                name="Is it still available?",
                keywords=(
                    "aktualne, aktualny, dostępne, dostępny, available, verfügbar, noch aktuell, noch frei"
                ),
                reply="Dzień dobry, tak, oferta jest nadal aktualna.",
            )
        ]
    )


class HistoryItem(BaseModel):
    role: Literal["me", "them"]
    text: str = Field(max_length=2000)


class MessageContext(BaseModel):
    loadingCity: str = Field(default="", max_length=300)
    unloadingCity: str = Field(default="", max_length=300)
    senderCompany: str = Field(default="", max_length=300)


class DecideRequest(BaseModel):
    platform: Literal["timocom", "transeu"]
    text: str = Field(min_length=1, max_length=4000)
    senderName: str = Field(default="", max_length=200)
    senderFirstName: str = Field(default="", max_length=100)
    isFirst: bool = False
    history: list[HistoryItem] = Field(default_factory=list, max_length=12)
    context: MessageContext = Field(default_factory=MessageContext)


class Decision(BaseModel):
    action: Literal["reply", "ignore", "none"]
    text: str = ""
    autoSend: bool = False
    source: str = ""
    note: str = ""
