import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  addManualObservation,
  loadCollectionJob,
  loadDashboard,
  loadHistory,
  priceExportUrl,
  startCollection,
} from "./api";
import type {
  CollectionJobDetails,
  CollectionMode,
  CollectionSchedule,
  CompetitorComparison,
  ComparisonItem,
  HistoryResponse,
  ManualObservationInput,
  Product,
  RegionCode,
  RegionsResponse,
} from "./types";
import {
  attentionCompetitor,
  bestComparable,
  bestCompetitor,
  collectionErrorLabel,
  collectionMethodLabel,
  collectionModeLabel,
  competitorDescription,
  differenceTone,
  exclusionReasonLabel,
  formatDate,
  formatDifference,
  formatPrice,
  formatPriceMovement,
  historyPriceMovement,
  jobLabel,
  observationStatus,
  offerStatusLabel,
  offerStatusTone,
  observedPriceValue,
  otherCompetitorsSummary,
  sortedCompetitors,
  summarizeCollectionAttempts,
} from "./view-model";

type ScopeFilter = "all" | "required" | "additional" | "component";
type DataFilter = "all" | "compared" | "partial" | "missing";
type MatchFilter = "all" | "exact" | "comparable" | "review" | "without-offers";
type SortKey = "priority" | "name" | "own-price" | "competitor-price" | "difference" | "freshness";

const initialRegions: RegionsResponse = {
  items: [],
  unscopedObservationCount: 0,
};

function scopeLabel(scope: Product["catalogScope"]) {
  if (scope === "required") return "Основной";
  if (scope === "additional") return "Дополнительный";
  return "Компонент";
}

function matchLabel(status: string) {
  if (status === "exact") return "Точное совпадение";
  if (status === "comparable") return "Сопоставимая модель";
  if (status === "review") return "Требует проверки";
  return "Отклонено";
}

function scheduleLabel(schedule: CollectionSchedule | null) {
  if (!schedule) return "Расписание не получено";
  if (schedule.cron === "0 3 * * *") return `Ежедневно в 03:00 · ${schedule.timeZone}`;
  return `${schedule.cron} · ${schedule.timeZone}`;
}

function bundleStatusLabel(
  reason: NonNullable<ComparisonItem["bundleStatus"]>["exclusionReason"],
) {
  if (reason === "mixed_sellers") return "Компоненты найдены у разных продавцов и не суммируются";
  if (reason === "mixed_price_types") return "Типы цен компонентов различаются и не суммируются";
  return "Для расчёта нужны две подтверждённые цены одного продавца";
}

function comparisonState(item: ComparisonItem | undefined) {
  const ownPrice = item?.own?.comparisonPrice?.normalizedPrice;
  const competitorPrice = bestCompetitor(item ?? ({ competitors: [] } as unknown as ComparisonItem))?.comparisonPrice
    ?.normalizedPrice;
  if (ownPrice && competitorPrice) return "compared";
  if (ownPrice || competitorPrice) return "partial";
  return "missing";
}

function latestComparisonDate(item: ComparisonItem | undefined) {
  if (!item) return 0;
  const dates = [item.own?.price?.receivedAt, ...item.competitors.map((offer) => offer.price?.receivedAt)]
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return dates.length > 0 ? Math.max(...dates) : 0;
}

function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [comparisons, setComparisons] = useState<ComparisonItem[]>([]);
  const [schedule, setSchedule] = useState<CollectionSchedule | null>(null);
  const [regions, setRegions] = useState<RegionsResponse>(initialRegions);
  const [priceRegion, setPriceRegion] = useState<RegionCode | "">("");
  const [selected, setSelected] = useState<Product | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("required");
  const [dataFilter, setDataFilter] = useState<DataFilter>("all");
  const [matchFilter, setMatchFilter] = useState<MatchFilter>("all");
  const [sort, setSort] = useState<SortKey>("priority");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<CollectionJobDetails | null>(null);
  const [startingMode, setStartingMode] = useState<CollectionMode | null>(null);
  const [manual, setManual] = useState<ManualObservationInput>({
    offerId: "",
    rawPrice: "",
    priceType: "retail",
    stockStatus: "",
    evidenceText: "",
    comment: "",
  });
  const [manualSaving, setManualSaving] = useState(false);
  const [manualMessage, setManualMessage] = useState<{ tone: "success" | "warning" | "error"; text: string } | null>(null);
  const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark");

  const comparisonMap = useMemo(
    () => new Map(comparisons.map((item) => [item.product.id, item])),
    [comparisons],
  );

  const refresh = async (silent = false, region: RegionCode | "" = priceRegion) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [, catalog, nextComparisons, nextSchedule, nextRegions] = await loadDashboard(
        region || undefined,
      );
      setProducts(catalog.items);
      setComparisons(nextComparisons.items);
      setSchedule(nextSchedule);
      setRegions(nextRegions);
    } catch {
      setError("Не удалось получить данные. Проверьте, что API и Docker запущены.");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void refresh(false, "");
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    if (!selected) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryExpanded(false);
    setHistory(null);
    setManualMessage(null);
    setManual({
      offerId: selected.offers.find((offer) => offer.matchStatus === "exact")?.id ?? selected.offers[0]?.id ?? "",
      rawPrice: "",
      priceType: "retail",
      stockStatus: "",
      regionCode: priceRegion || undefined,
      evidenceText: "",
      comment: "",
    });
    void loadHistory(selected.id)
      .then((data) => {
        if (!cancelled) setHistory(data);
      })
      .catch(() => {
        if (!cancelled) setManualMessage({ tone: "error", text: "Историю цен загрузить не удалось" });
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, priceRegion]);

  useEffect(() => {
    if (!job || !["pending", "running"].includes(job.status)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadCollectionJob(job.id)
        .then((nextJob) => {
          if (cancelled) return;
          setJob(nextJob);
          if (!["pending", "running"].includes(nextJob.status)) {
            void refresh(true);
            if (selected) void loadHistory(selected.id).then(setHistory).catch(() => undefined);
          }
        })
        .catch(() => {
          if (!cancelled) setError("Не удалось проверить состояние сбора. Обновите страницу.");
        });
    }, 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [job, selected]);

  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected]);

  const visibleProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("ru-RU");
    return products
      .filter((product) => scope === "all" || product.catalogScope === scope)
      .filter((product) => dataFilter === "all" || comparisonState(comparisonMap.get(product.id)) === dataFilter)
      .filter((product) => {
        if (matchFilter === "all") return true;
        const competitorOffers = product.offers.filter(
          (offer) => offer.competitorUrl !== product.ownUrl,
        );
        if (matchFilter === "without-offers") return competitorOffers.length === 0;
        return competitorOffers.some((offer) => offer.matchStatus === matchFilter);
      })
      .filter((product) => {
        if (!normalizedQuery) return true;
        return `${product.name} ${product.article ?? ""}`
          .toLocaleLowerCase("ru-RU")
          .includes(normalizedQuery);
      })
      .sort((left, right) => {
        if (sort === "name") return left.name.localeCompare(right.name, "ru");
        if (sort === "own-price") {
          const leftPrice = Number(comparisonMap.get(left.id)?.own?.comparisonPrice?.normalizedPrice ?? Infinity);
          const rightPrice = Number(comparisonMap.get(right.id)?.own?.comparisonPrice?.normalizedPrice ?? Infinity);
          return leftPrice - rightPrice;
        }
        if (sort === "competitor-price") {
          const leftPrice = Number(bestCompetitor(comparisonMap.get(left.id) ?? ({ competitors: [] } as unknown as ComparisonItem))?.comparisonPrice?.normalizedPrice ?? Infinity);
          const rightPrice = Number(bestCompetitor(comparisonMap.get(right.id) ?? ({ competitors: [] } as unknown as ComparisonItem))?.comparisonPrice?.normalizedPrice ?? Infinity);
          return leftPrice - rightPrice;
        }
        if (sort === "difference") {
          const leftDelta = Number(bestCompetitor(comparisonMap.get(left.id) ?? ({ competitors: [] } as unknown as ComparisonItem))?.difference.amount ?? -Infinity);
          const rightDelta = Number(bestCompetitor(comparisonMap.get(right.id) ?? ({ competitors: [] } as unknown as ComparisonItem))?.difference.amount ?? -Infinity);
          return rightDelta - leftDelta;
        }
        if (sort === "freshness") {
          const leftDate = latestComparisonDate(comparisonMap.get(left.id));
          const rightDate = latestComparisonDate(comparisonMap.get(right.id));
          return rightDate - leftDate;
        }
        return left.priority - right.priority || left.name.localeCompare(right.name, "ru");
      });
  }, [products, query, scope, dataFilter, matchFilter, sort, comparisonMap]);

  const handleStartCollection = async (mode: CollectionMode) => {
    setStartingMode(mode);
    setError(null);
    try {
      const created = await startCollection(mode);
      const details = await loadCollectionJob(created.id);
      setJob(details);
    } catch {
      setError("Сбор не удалось запустить. Проверьте сервис сборщика.");
    } finally {
      setStartingMode(null);
    }
  };

  const handleManualSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !manual.offerId || !manual.rawPrice) return;
    setManualSaving(true);
    setManualMessage(null);
    try {
      const result = await addManualObservation({
        ...manual,
        rawPrice: manual.rawPrice.replace(",", "."),
        stockStatus: manual.stockStatus || undefined,
        evidenceText: manual.evidenceText || undefined,
        comment: manual.comment || undefined,
      });
      const valid = result.observation.reliability === "valid";
      setManualMessage({
        tone: valid ? "success" : "warning",
        text: valid
          ? "Цена сохранена и участвует в сравнении"
          : "Цена сохранена в истории, но не участвует в сравнении из-за правил надёжности",
      });
      setManual((value) => ({ ...value, rawPrice: "", evidenceText: "", comment: "" }));
      const [nextHistory] = await Promise.all([loadHistory(selected.id), refresh(true)]);
      setHistory(nextHistory);
    } catch {
      setManualMessage({ tone: "error", text: "Цена не сохранена. Проверьте сумму и выбранный источник" });
    } finally {
      setManualSaving(false);
    }
  };

  const handleRegionChange = (region: RegionCode | "") => {
    setPriceRegion(region);
    setSelected(null);
    void refresh(false, region);
  };

  const jobActive = job ? ["pending", "running"].includes(job.status) : false;
  const collectionResults = summarizeCollectionAttempts(job?.attempts ?? []);
  const successfulCollectionResults = collectionResults.filter((result) => result.status === "success");
  const failedCollectionResults = collectionResults.filter((result) => result.status === "failed");
  const skippedCollectionResults = collectionResults.filter((result) => result.status === "skipped");
  const collectionProblems = [...failedCollectionResults, ...skippedCollectionResults];
  const activeRegion = regions.items.find((region) => region.code === priceRegion) ?? null;

  const competitorDetail = (competitor: CompetitorComparison, index: number) => {
    const tone = offerStatusTone(competitor);
    const currentPrice = competitor.referencePrice ?? competitor.price;
    const description = competitorDescription(
      competitor.comparisonProfile?.summary ?? competitor.matchReason,
    );
    const priceExclusion = exclusionReasonLabel(currentPrice?.exclusionReason);
    return (
      <details className={`competitor-detail ${tone}`} key={competitor.offerId}>
        <summary>
          <span className="competitor-summary-main">
            {tone === "warning" && <span className="attention-icon" aria-label="Требует проверки">!</span>}
            <span>
              <strong>{competitor.seller}</strong>
              <small>Конкурент {index + 1}</small>
            </span>
          </span>
          <span className="competitor-summary-price">
            <strong>{formatPrice(observedPriceValue(currentPrice))}</strong>
          </span>
          <span className={`trust-badge ${tone}`}>{offerStatusLabel(competitor)}</span>
        </summary>
        <div className="competitor-detail-body">
          <div>
            <a className="competitor-link" href={competitor.url} target="_blank" rel="noreferrer">
              Открыть карточку продавца
            </a>
            <small>
              {collectionMethodLabel(currentPrice)}
              {currentPrice ? ` · ${formatDate(currentPrice.observedAt ?? currentPrice.receivedAt)}` : ""}
              {currentPrice?.region ? ` · ${currentPrice.region}` : ""}
            </small>
          </div>
          {tone === "valid" && competitor.difference.amount != null && (
            <span className={`market-delta ${differenceTone(competitor.difference.amount)}`}>
              {formatDifference(competitor.difference.amount, competitor.difference.percent)}
            </span>
          )}
          {tone === "comparable" && competitor.referenceDifference && (
            <span className={`market-delta ${differenceTone(competitor.referenceDifference.amount)}`}>
              {formatDifference(
                competitor.referenceDifference.amount,
                competitor.referenceDifference.percent,
              )}
            </span>
          )}
          {tone === "warning" && <span className="excluded-label">Цена не входит в итоговое сравнение</span>}
          {tone === "comparable" && <span className="excluded-label">Ориентир не входит в точный итог</span>}
          {priceExclusion && <p className="price-exclusion"><strong>Почему цена не участвует</strong>{priceExclusion}</p>}
          {description.length > 0 && <div className="competitor-notes">{description.map((part) => <p key={part.label}><strong>{part.label}</strong>{part.text}</p>)}</div>}
          {competitor.comparisonProfile && (
            <div className="comparison-specs">
              <div className="comparison-specs-heading">
                <strong>Сопоставление характеристик</strong>
                <small>Проверено {formatDate(competitor.comparisonProfile.verified_on, false)}</small>
              </div>
              {competitor.comparisonProfile.specs.map((spec) => (
                <div className={`comparison-spec ${spec.result}`} key={spec.label}>
                  <strong>{spec.label}</strong>
                  <span><b>ЦТО</b>{spec.own_value}</span>
                  <span><b>Аналог</b>{spec.candidate_value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </details>
    );
  };

  const productRow = (product: Product, mobile = false) => {
    const item = comparisonMap.get(product.id);
    const competitors = sortedCompetitors(item ?? ({ competitors: [] } as unknown as ComparisonItem));
    const confirmed = bestCompetitor(item ?? ({ competitors: [] } as unknown as ComparisonItem));
    const comparable = bestComparable(item ?? ({ competitors: [] } as unknown as ComparisonItem));
    const otherCompetitors = item ? otherCompetitorsSummary(item) : null;
    const ownPrice = item?.own?.price;
    const modelCell = <div className="model-data"><strong>{product.name}</strong><span>{product.article ?? "Артикул не указан"}</span></div>;
    const ownCell = <div className="price-data own-price" data-label="Наша цена"><strong>{formatPrice(ownPrice?.normalizedPrice)}</strong>{item?.own?.url ? <a href={item.own.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>ЦТО</a> : <span>Карточка ЦТО не указана</span>}<small>{collectionMethodLabel(ownPrice)}{ownPrice ? ` · ${formatDate(ownPrice.observedAt ?? ownPrice.receivedAt)}` : ""}{ownPrice?.region ? ` · ${ownPrice.region}` : ""}</small></div>;
    const confirmedCell = (
      <div className="price-data competitor-result" data-label="Подтверждённая цена">
        <strong>{formatPrice(confirmed?.comparisonPrice?.normalizedPrice)}</strong>
        {confirmed ? <a href={confirmed.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{confirmed.seller}</a> : <span>Нет цены для итога</span>}
        {confirmed && <small>{formatDate(confirmed.comparisonPrice?.observedAt ?? confirmed.comparisonPrice?.receivedAt)}{confirmed.comparisonPrice?.region ? ` · ${confirmed.comparisonPrice.region}` : ""}</small>}
      </div>
    );
    const marketReferenceCell = comparable ? (
      <div className="price-data market-reference-result" data-label="Цена требует проверки">
        <span className="comparable-label">{offerStatusLabel(comparable)}</span>
        <strong>{formatPrice(observedPriceValue(comparable.referencePrice))}</strong>
        <a href={comparable.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{comparable.seller}</a>
        <small>Не входит в точный итог</small>
      </div>
    ) : (
      <div className={`other-competitors ${otherCompetitors ? "available" : "quiet"}`} data-label="Цена требует проверки">
        {otherCompetitors ? <><strong>{otherCompetitors.countLabel}</strong><small>{otherCompetitors.priceNote ?? "Все источники в карточке"}</small></> : <span>—</span>}
      </div>
    );
    const displayedDifference = confirmed?.difference.amount != null
      ? confirmed.difference
      : comparable?.referenceDifference ?? null;
    const differenceCell = (
      <div className="price-data comparison-difference-result" data-label="Разница в цене">
        {displayedDifference?.amount != null ? (
          <>
            <strong className={differenceTone(displayedDifference.amount)}>
              {formatDifference(displayedDifference.amount, displayedDifference.percent)}
            </strong>
            <small>{confirmed ? "между нашей и подтверждённой ценой" : "между нашей ценой и ориентиром"}</small>
          </>
        ) : (
          <>
            <strong className="no-price-difference">—</strong>
            <small>Недостаточно данных для сравнения</small>
          </>
        )}
      </div>
    );
    if (mobile) {
      return <article className="product-card" key={product.id} role="button" tabIndex={0} onClick={() => setSelected(product)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelected(product); }}>{modelCell}{ownCell}{confirmedCell}{marketReferenceCell}{differenceCell}</article>;
    }
    return (
      <tr key={product.id} onClick={() => setSelected(product)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && setSelected(product)}>
        <td>{modelCell}</td>
        <td>{ownCell}</td>
        <td>{confirmedCell}</td>
        <td>{marketReferenceCell}</td>
        <td>{differenceCell}</td>
      </tr>
    );
  };

  const selectedComparison = selected ? comparisonMap.get(selected.id) : undefined;
  const selectedCompetitors = selectedComparison
    ? sortedCompetitors(selectedComparison)
    : [];
  const selectedConfirmed = selectedComparison ? bestCompetitor(selectedComparison) : null;
  const selectedComparable = selectedComparison ? bestComparable(selectedComparison) : null;
  const selectedAttention = selectedComparison ? attentionCompetitor(selectedComparison) : null;
  const visibleHistory = historyExpanded ? history?.items : history?.items.slice(0, 3);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">ЦТО</div>
        <div className="header-copy">
          <p className="eyebrow">Мониторинг рынка</p>
          <h1>Цены конкурентов</h1>
        </div>
        <div className="header-actions">
          <button className="secondary-button theme-button" onClick={() => setDark((value) => !value)}>{dark ? "Светлая тема" : "Тёмная тема"}</button>
          <button className="secondary-button" title="Все активные точные, сопоставимые и требующие проверки источники" onClick={() => void handleStartCollection("full")} disabled={startingMode !== null || jobActive}>
            {startingMode === "full" ? "Запускаем полный" : "Полный сбор"}
          </button>
          <button className="primary-button" title="Основные рабочие источники" onClick={() => void handleStartCollection("fast")} disabled={startingMode !== null || jobActive}>
            {startingMode === "fast" ? "Запускаем" : jobActive ? jobLabel(job) : "Быстрый сбор"}
          </button>
        </div>
      </header>

      <main>
        <section className="intro-row">
          <div>
            <div className="stage-pill">Рабочая версия</div>
            <h2>Сравнение цен по точным моделям</h2>
            <p>Система собирает цены из доступных источников, хранит историю и не подменяет отсутствующие данные нулями.</p>
          </div>
          <div className="schedule-card"><span>Автоматический полный сбор</span><strong>{scheduleLabel(schedule)}</strong></div>
        </section>

        {job && (
          <section className={`job-banner ${job.status}`} aria-live="polite">
            <div><strong>{jobLabel(job)} · {collectionModeLabel(job.collectionMode)}</strong><span>{successfulCollectionResults.length} успешно · {failedCollectionResults.length} проблемно · {skippedCollectionResults.length} пропущено</span></div>
            <span className="job-time">{job.finishedAt ? formatDate(job.finishedAt) : "Обновляем состояние"}</span>
            {collectionProblems.length > 0 && (
              <details className="job-problems">
                <summary>Показать проблемные карточки · {collectionProblems.length}</summary>
                <div className="job-problem-list">
                  {collectionProblems.map((result) => (
                    <details className={`job-problem ${result.status}`} key={result.key}>
                      <summary>
                        <span><strong>{result.offer?.product.name ?? result.source.name}</strong><small>{result.source.name} · {result.attempts.length} {result.attempts.length === 1 ? "попытка" : "попытки"}</small></span>
                        <b>{result.status === "failed" ? "Проблема" : "Пропущено"}</b>
                      </summary>
                      <div>{result.attempts.map((attempt) => <p key={attempt.id}>Попытка {attempt.attemptNumber} · {collectionErrorLabel(attempt.errorCode, attempt.errorMessage)}</p>)}</div>
                    </details>
                  ))}
                </div>
              </details>
            )}
          </section>
        )}

        <section className="region-panel" aria-label="Основные региональные точки">
          <div className="region-panel-heading">
            <div>
              <span className="eyebrow">Региональный срез</span>
              <h2>Основные точки России</h2>
              <p>Таблица показывает только наблюдения выбранной точки. Цены разных регионов не смешиваются.</p>
            </div>
            <strong>{activeRegion?.name ?? "Без региональной привязки"}</strong>
          </div>
          <div className="region-points">
            <button type="button" className={!priceRegion ? "active" : ""} aria-pressed={!priceRegion} onClick={() => handleRegionChange("")}>
              <strong>Без привязки</strong>
              <span>{regions.unscopedObservationCount} наблюдений</span>
            </button>
            {regions.items.map((region) => (
              <button type="button" className={priceRegion === region.code ? "active" : ""} aria-pressed={priceRegion === region.code} onClick={() => handleRegionChange(region.code)} key={region.code}>
                <strong>{region.name}</strong>
                <span>{region.observationCount > 0 ? `${region.observationCount} наблюдений` : "Данных пока нет"}</span>
              </button>
            ))}
          </div>
          <p className="region-rule">Неизвестный регион остаётся неизвестным. Домен продавца или город в адресе сайта сам по себе не считается доказательством региональной цены.</p>
        </section>

        <section className="catalog-panel">
          <div className="panel-heading">
            <div><h2>Мониторинг по моделям</h2><p>Показано {visibleProducts.length} позиций · {activeRegion ? `регион ${activeRegion.name}` : "цены без подтверждённой региональной привязки"} · точный итог отделён от рыночных ориентиров</p></div>
            <div className="panel-actions">
              <a className="export-button" href={priceExportUrl}>Скачать CSV</a>
              <button className="refresh-button" onClick={() => void refresh()} disabled={loading}>{loading ? "Обновление" : "Обновить"}</button>
            </div>
          </div>

          <div className="filters">
            <label className="search-field"><span>Поиск</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Модель или артикул" /></label>
            <label><span>Часть каталога</span><select value={scope} onChange={(event) => setScope(event.target.value as ScopeFilter)}><option value="required">29 обязательных</option><option value="component">Компоненты комплекта</option><option value="additional">Дополнительные</option><option value="all">Все товары</option></select></label>
            <label><span>Данные</span><select value={dataFilter} onChange={(event) => setDataFilter(event.target.value as DataFilter)}><option value="all">Все состояния</option><option value="compared">Есть сравнение</option><option value="partial">Только одна цена</option><option value="missing">Нет цен</option></select></label>
            <label><span>Сопоставление</span><select value={matchFilter} onChange={(event) => setMatchFilter(event.target.value as MatchFilter)}><option value="all">Все источники</option><option value="exact">Точное</option><option value="comparable">Сопоставимые модели</option><option value="review">Требует проверки</option><option value="without-offers">Без источников</option></select></label>
            <label><span>Сортировка</span><select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}><option value="priority">По приоритету</option><option value="name">По названию</option><option value="own-price">По нашей цене</option><option value="competitor-price">По цене конкурента</option><option value="difference">По разнице цен</option><option value="freshness">Сначала свежие</option></select></label>
          </div>

          {error && <div className="error-state"><strong>Ошибка подключения</strong><p>{error}</p><button className="secondary-button" onClick={() => void refresh()}>Попробовать снова</button></div>}
          {loading && <div className="loading-state"><div className="spinner"></div><p>Загружаем цены из базы</p></div>}
          {!loading && !error && visibleProducts.length === 0 && <div className="empty-state"><strong>Ничего не найдено</strong><p>Измените поисковый запрос или фильтры.</p></div>}

          {!loading && !error && visibleProducts.length > 0 && (
            <>
              <div className="table-wrap desktop-table"><table><thead><tr><th>Модель</th><th>Наша цена</th><th>Подтверждённая цена конкурента</th><th>Цена требует проверки</th><th>Разница в цене</th></tr></thead><tbody>{visibleProducts.map((product) => productRow(product))}</tbody></table></div>
              <div className="mobile-list">{visibleProducts.map((product) => productRow(product, true))}</div>
            </>
          )}
        </section>
      </main>

      {selected && (
        <div className="drawer-backdrop" onMouseDown={() => setSelected(null)}>
          <aside className="drawer" onMouseDown={(event) => event.stopPropagation()} aria-label="Карточка товара">
            <button className="drawer-close" onClick={() => setSelected(null)} aria-label="Закрыть">Закрыть</button>
            <span className={`scope-badge ${selected.catalogScope}`}>{scopeLabel(selected.catalogScope)}</span>
            <h2>{selected.name}</h2>
            <p className="drawer-article">{selected.article ?? "Артикул не указан"}</p>
            {selected.ownUrl ? <a className="external-link" href={selected.ownUrl} target="_blank" rel="noreferrer">Открыть карточку ЦТО</a> : <div className="notice">У комплекта нет отдельной карточки ЦТО. Это допустимо по условиям задания.</div>}

            <section className="price-snapshot" aria-label="Краткое сравнение цен">
              <article><span>Наша цена</span><strong>{formatPrice(observedPriceValue(selectedComparison?.own?.price))}</strong></article>
              <article><span>Итог конкурента</span><strong>{formatPrice(selectedConfirmed?.comparisonPrice?.normalizedPrice)}</strong><small>{selectedConfirmed?.seller ?? "Нет подтверждённой цены"}</small></article>
              <article><span>Разница</span><strong className={differenceTone(selectedConfirmed?.difference.amount)}>{formatDifference(selectedConfirmed?.difference.amount, selectedConfirmed?.difference.percent)}</strong></article>
              {selectedComparable && <article className="comparable"><span>{offerStatusLabel(selectedComparable)}</span><strong>{formatPrice(observedPriceValue(selectedComparable.referencePrice))}</strong><small>{selectedComparable.seller}{selectedComparable.referenceDifference ? ` · ${formatDifference(selectedComparable.referenceDifference.amount, selectedComparable.referenceDifference.percent)}` : ""}</small></article>}
              {selectedAttention && <article className="attention"><span><span className="attention-icon small" aria-hidden="true">!</span>Проверить</span><strong>{formatPrice(observedPriceValue(selectedAttention.price))}</strong><small>{selectedAttention.seller} · не входит в итог</small></article>}
            </section>

            {selected.bundleParts.length > 0 && <section className="drawer-section"><h3>Состав комплекта</h3><p className="muted">Откройте оба компонента и внесите цены из одного предложения продавца. После второй цены сумма появится у комплекта автоматически.</p>{selected.bundleParts.map((part) => <button type="button" className="component" key={part.componentProduct.id} onClick={() => { const component = products.find((product) => product.id === part.componentProduct.id); if (component) setSelected(component); }}><strong>{part.componentProduct.name}</strong><span>{part.componentProduct.article ?? "Артикул не указан"} · {part.quantity} шт.</span></button>)}{comparisonMap.get(selected.id)?.bundleStatus?.ready ? <div className="notice success">Комплект рассчитан по двум ценам одного продавца</div> : <div className="notice">{bundleStatusLabel(comparisonMap.get(selected.id)?.bundleStatus?.exclusionReason ?? "incomplete_bundle")}</div>}</section>}

            {selected.catalogScope === "component" && <div className="notice">Укажите цену из одного и того же предложения продавца для обоих компонентов комплекта. Название продавца и ссылку сохраните в подтверждении цены.</div>}

            <section className="drawer-section competitor-overview">
              <div className="section-heading"><div><h3>Источники конкурентов</h3><p>Нажмите на строку, чтобы увидеть доказательства и причину статуса</p></div><span className="count-badge">{selectedCompetitors.length}</span></div>
              {selectedCompetitors.length === 0 ? <p className="muted">Конкурентные предложения для этой модели пока не найдены.</p> : <div className="drawer-competitors">{selectedCompetitors.map((competitor, index) => competitorDetail(competitor, index))}</div>}
              <p className="comparison-note">Итоговая разница рассчитывается только по точным подтверждённым ценам. Сопоставимый аналог показывает отдельный рыночный ориентир и явные отличия характеристик, но не меняет строгий итог.</p>
            </section>

            <section className="drawer-section">
              <div className="section-heading"><div><h3>История цен</h3><p>{historyExpanded ? "Показаны все сохранённые наблюдения" : "Три последних наблюдения"}</p></div><span className="count-badge">{history?.total ?? 0}</span></div>
              {historyLoading && <div className="inline-loading"><div className="spinner"></div>Загружаем историю</div>}
              {!historyLoading && history?.items.length === 0 && <p className="muted">Истории пока нет. Запустите сбор или внесите цену вручную.</p>}
              <div className="history-list">{visibleHistory?.map((entry, index) => { const movement = historyPriceMovement(history?.items ?? [], index); const exclusion = exclusionReasonLabel(entry.exclusionReason); return <article className={`history-item ${entry.reliability}`} key={entry.id}><div><strong>{formatPrice(entry.normalizedPrice ?? entry.rawPrice)}</strong><a href={entry.offer.competitorUrl} target="_blank" rel="noreferrer">{entry.offer.source.domain === "centr-to.ru" ? "Наша цена · ЦТО" : `Конкурент · ${entry.offer.seller.displayName}`}</a><span>{formatDate(entry.receivedAt)} · {entry.region ?? "регион не указан"}</span></div><div className="history-status"><span className={`method-badge ${entry.method}`}>{entry.method === "manual" ? "Вручную" : "Автоматически"}</span><small>{observationStatus(entry)}</small>{movement && <><span className={`price-movement history-movement ${movement.direction}`}>{formatPriceMovement(movement)}</span><small>к предыдущему наблюдению этого источника</small></>}</div>{exclusion && <p><strong>Почему цена не участвует</strong>{exclusion}</p>}</article>; })}</div>
              {(history?.items.length ?? 0) > 3 && <button type="button" className="history-toggle" onClick={() => setHistoryExpanded((value) => !value)}>{historyExpanded ? "Свернуть до трёх последних" : `Показать всю историю · ${history?.total ?? history?.items.length}`}</button>}
            </section>

            <details className="drawer-section manual-section">
              <summary><span><strong>Внести цену вручную</strong><small>Дополнительное действие</small></span></summary>
              <div className="manual-content">
              {selected.bundleParts.length > 0 ? <div className="notice">Цена комплекта напрямую не вводится. Внесите отдельно цены двух компонентов из предложения одного продавца.</div> : selected.offers.length === 0 ? <div className="notice">Для ручного ввода сначала нужен источник товара.</div> : (
                <form className="manual-form" onSubmit={(event) => void handleManualSubmit(event)}>
                  <label><span>Источник</span><select value={manual.offerId} onChange={(event) => setManual((value) => ({ ...value, offerId: event.target.value }))}>{selected.offers.map((offer) => <option value={offer.id} key={offer.id}>{offer.seller.displayName} · {matchLabel(offer.matchStatus)}</option>)}</select></label>
                  <div className="form-row"><label><span>Цена в рублях</span><input required inputMode="decimal" value={manual.rawPrice} onChange={(event) => setManual((value) => ({ ...value, rawPrice: event.target.value }))} placeholder="95000" /></label><label><span>Тип цены</span><select value={manual.priceType} onChange={(event) => setManual((value) => ({ ...value, priceType: event.target.value as ManualObservationInput["priceType"] }))}><option value="retail">Розничная</option><option value="rrp">Рекомендованная</option><option value="sale">Со скидкой</option><option value="quote">По запросу</option><option value="unknown">Не указано</option></select></label></div>
                  <label><span>Регион цены</span><select value={manual.regionCode ?? ""} onChange={(event) => setManual((value) => ({ ...value, regionCode: (event.target.value || undefined) as RegionCode | undefined }))}><option value="">Не подтверждён</option>{regions.items.map((region) => <option value={region.code} key={region.code}>{region.name} · {region.federalDistrict}</option>)}</select><small>Выбирайте регион только если он явно указан в карточке, предложении или подтверждении продавца.</small></label>
                  <label><span>Наличие</span><input value={manual.stockStatus} onChange={(event) => setManual((value) => ({ ...value, stockStatus: event.target.value }))} placeholder="В наличии или под заказ" /></label>
                  <label><span>Подтверждение цены</span><textarea required={Boolean(manual.regionCode)} value={manual.evidenceText} onChange={(event) => setManual((value) => ({ ...value, evidenceText: event.target.value }))} placeholder={manual.regionCode ? "Обязательно укажите, где подтверждён регион и цена" : "Где и когда увидели цену"} /></label>
                  {manualMessage && <div className={`form-message ${manualMessage.tone}`}>{manualMessage.text}</div>}
                  <button className="primary-button" type="submit" disabled={manualSaving}>{manualSaving ? "Сохраняем" : "Сохранить цену"}</button>
                </form>
              )}
              </div>
            </details>

          </aside>
        </div>
      )}
    </div>
  );
}

export default App;
