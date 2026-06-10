from __future__ import annotations

from dataclasses import dataclass

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.validation.state import ValidationState
from data_rover.core.view.schema import View


@dataclass
class Session:
    metamodel: Metamodel | None = None
    model: Model | None = None
    view: View | None = None
    #: issue store seeded by the last FULL validation of `model`; incremental
    #: paths (Phase C) delta from it via ValidationState.replace
    validation: ValidationState | None = None


_session = Session()


def get_session() -> Session:
    return _session


def reset_session() -> None:
    _session.metamodel = None
    _session.model = None
    _session.view = None
    _session.validation = None
