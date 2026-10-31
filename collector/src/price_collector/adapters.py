from typing import Protocol

from .models import CollectedObservation, SourceTask


class SourceAdapter(Protocol):
    key: str
    method: str

    def collect(self, task: SourceTask) -> CollectedObservation: ...


class AdapterRegistry:
    def __init__(self, adapters: tuple[SourceAdapter, ...] = ()) -> None:
        self._adapters = {adapter.key: adapter for adapter in adapters}

    def get(self, source_key: str) -> SourceAdapter | None:
        return self._adapters.get(source_key)

    def register(self, adapter: SourceAdapter) -> None:
        if adapter.key in self._adapters:
            raise ValueError(f"Adapter already registered: {adapter.key}")
        self._adapters[adapter.key] = adapter
