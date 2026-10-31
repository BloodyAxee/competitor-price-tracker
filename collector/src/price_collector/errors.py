class CollectionError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str,
        http_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status


class RetryableCollectionError(CollectionError):
    pass


class PermanentCollectionError(CollectionError):
    pass


class ManualFallbackRequired(CollectionError):
    pass
