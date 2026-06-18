from dataclasses import dataclass, field


@dataclass
class Constraints:
    max_chars: int | None = None
    max_lines: int | None = None
    shrink_floor_pt: float | None = None
    max_rows: int | None = None
    max_cols: int | None = None
    fit: str | None = None  # "cover" | "contain"


@dataclass
class Slot:
    id: str
    name: str
    type: str  # "text" | "table" | "image"
    shape_id: int
    required: bool = False
    default: object = None
    constraints: Constraints = field(default_factory=Constraints)


@dataclass
class SlideType:
    id: str
    name: str
    description: str
    source_slide_index: int
    slots: list[Slot]

    def slot(self, slot_id: str) -> "Slot | None":
        return next((s for s in self.slots if s.id == slot_id), None)


@dataclass
class Template:
    id: str
    name: str
    description: str
    slide_types: list[SlideType]
    pptx_path: str

    def slide_type(self, type_id: str) -> "SlideType | None":
        return next((t for t in self.slide_types if t.id == type_id), None)


@dataclass
class SlotError:
    slide_index: int
    slot_id: str | None
    code: str
    message: str

    def to_dict(self) -> dict:
        return {"slide_index": self.slide_index, "slot_id": self.slot_id,
                "code": self.code, "message": self.message}
