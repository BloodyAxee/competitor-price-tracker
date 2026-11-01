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
  CatalogSummary,
  CollectionJobDetails,
  CollectionSchedule,
  ComparisonItem,
  HistoryResponse,
  ManualObservationInput,
  Product,
} from "./types";
import {
  bestCompetitor,
  differenceTone,
  formatDate,
  formatDifference,
  formatPrice,
  jobLabel,
  observationStatus,
} from "./view-model";

type ScopeFilter = "all" | "required" | "additional" | "component";
type DataFilter = "all" | "compared" | "partial" | "missing";
type MatchFilter = "all" | "exact" | "review" | "without-offers";
type SortKey = "priority" | "name" | "difference" | "freshness";
type ColumnKey = "own" | "competitor" | "difference" | "status";

const initialSummary: CatalogSummary = {
  total: 0,
  required: 0,
  additional: 0,
  ownUrls: 0,
  exactOffers: 0,
  reviewOffers: 0,
};

function scopeLabel(scope: Product["catalogScope"]) {
  if (scope === "required") return "Основной";
  if (scope === "additional") return "Дополнительный";
  return "Компонент";
}

function matchLabel(status: string) {
  if (status === "exact") return "Точное совпадение";
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
  const ownPrice = item?.own?.price?.normalizedPrice;
  const competitorPrice = bestCompetitor(item ?? ({ competitors: [] } as unknown as ComparisonItem))?.price
    ?.normalizedPrice;
  if (ownPrice && competitorPrice) return "compared";
  if (ownPrice || competitorPrice) return "partial";
  return "missing";
}

function App() {
  const [summary, setSummary] = useState(initialSummary);
  const [products, setProducts] = useState<Product[]>([]);
  const [comparisons, setComparisons] = useState<ComparisonItem[]>([]);
  const [schedule, setSchedule] = useState<CollectionSchedule | null>(null);
  const [selected, setSelected] = useState<Product | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("required");
  const [dataFilter, setDataFilter] = useState<DataFilter>("all");
  const [matchFilter, setMatchFilter] = useState<MatchFilter>("all");
  const [sort, setSort] = useState<SortKey>("priority");
  const [columns, setColumns] = useState<Record<ColumnKey, boolean>>({
    own: true,
    competitor: true,
    difference: true,
    status: true,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<CollectionJobDetails | null>(null);
  const [startingJob, setStartingJob] = useState(false);
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

  const refresh = async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [nextSummary, catalog, nextComparisons, nextSchedule] = await loadDashboard();
      setSummary(nextSummary);
      setProducts(catalog.items);
      setComparisons(nextComparisons.items);
      setSchedule(nextSchedule);
    } catch {
      setError("Не удалось получить данные. Проверьте, что API и Docker запущены.");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
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
    setHistory(null);
    setManualMessage(null);
    setManual({
      offerId: selected.offers.find((offer) => offer.matchStatus === "exact")?.id ?? selected.offers[0]?.id ?? "",
      rawPrice: "",
      priceType: "retail",
      stockStatus: "",
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
  }, [selected]);

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
        if (matchFilter === "without-offers") return product.offers.length === 0;
        return product.offers.some((offer) => offer.matchStatus === matchFilter);
      })
      .filter((product) => {
        if (!normalizedQuery) return true;
        return `${product.name} ${product.article ?? ""}`
          .toLocaleLowerCase("ru-RU")
          .includes(normalizedQuery);
      })
      .sort((left, right) => {
        if (sort === "name") return left.name.localeCompare(right.name, "ru");
        if (sort === "difference") {
          const leftDelta = Number(bestCompetitor(comparisonMap.get(left.id) ?? ({ competitors: [] } as unknown as ComparisonItem))?.difference.amount ?? -Infinity);
          const rightDelta = Number(bestCompetitor(comparisonMap.get(right.id) ?? ({ competitors: [] } as unknown as ComparisonItem))?.difference.amount ?? -Infinity);
          return rightDelta - leftDelta;
        }
        if (sort === "freshness") {
          const leftDate = Date.parse(comparisonMap.get(left.id)?.own?.price?.receivedAt ?? "") || 0;
          const rightDate = Date.parse(comparisonMap.get(right.id)?.own?.price?.receivedAt ?? "") || 0;
          return rightDate - leftDate;
        }
        return left.priority - right.priority || left.name.localeCompare(right.name, "ru");
      });
  }, [products, query, scope, dataFilter, matchFilter, sort, comparisonMap]);

  const dashboardStats = useMemo(() => {
    const required = products.filter((product) => product.catalogScope === "required");
    const compared = required.filter((product) => comparisonState(comparisonMap.get(product.id)) === "compared").length;
    const withAnyPrice = required.filter((product) => comparisonState(comparisonMap.get(product.id)) !== "missing").length;
    const better = required.filter((product) => {
      const competitor = bestCompetitor(comparisonMap.get(product.id) ?? ({ competitors: [] } as unknown as ComparisonItem));
      return Number(competitor?.difference.amount ?? 0) > 0;
    }).length;
    return { compared, withAnyPrice, better };
  }, [products, comparisonMap]);

  const handleStartCollection = async () => {
    setStartingJob(true);
    setError(null);
    try {
      const created = await startCollection();
      const details = await loadCollectionJob(created.id);
      setJob(details);
    } catch {
      setError("Сбор не удалось запустить. Проверьте сервис сборщика.");
    } finally {
      setStartingJob(false);
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

  const jobActive = job ? ["pending", "running"].includes(job.status) : false;
  const failedAttempts = job?.attempts.filter((attempt) => attempt.status === "failed") ?? [];

  const productRow = (product: Product, mobile = false) => {
    const item = comparisonMap.get(product.id);
    const competitor = bestCompetitor(item ?? ({ competitors: [] } as unknown as ComparisonItem));
    const ownPrice = item?.own?.price;
    const competitorPrice = competitor?.price;
    const delta = competitor?.difference;
    const modelCell = <div className="model-data"><strong>{product.name}</strong><span>{product.article ?? "Артикул не указан"}</span></div>;
    const ownCell = <div className="price-data"><strong>{formatPrice(ownPrice?.normalizedPrice)}</strong><span>{item?.own?.source.name ?? "Свой источник не указан"}</span></div>;
    const competitorCell = <div className="price-data"><strong>{formatPrice(competitorPrice?.normalizedPrice)}</strong><span>{competitor?.seller ?? "Конкурент не указан"}</span></div>;
    const differenceCell = <div className={`delta-data ${differenceTone(delta?.amount)}`}><strong>{formatDifference(delta?.amount, delta?.percent)}</strong><span>{delta?.amount == null ? "Нужны обе цены" : Number(delta.amount) > 0 ? "Наша цена ниже" : Number(delta.amount) < 0 ? "Наша цена выше" : "Цены равны"}</span></div>;
    const statusCell = <div className="status-data"><span className={`data-badge ${comparisonState(item)}`}>{comparisonState(item) === "compared" ? "Сравнено" : comparisonState(item) === "partial" ? "Одна цена" : "Нет цен"}</span><small>{formatDate(ownPrice?.receivedAt ?? competitorPrice?.receivedAt)}</small></div>;
    if (mobile) {
      return <button className="product-card" key={product.id} onClick={() => setSelected(product)}>{modelCell}{ownCell}{competitorCell}{differenceCell}{statusCell}</button>;
    }
    return (
      <tr key={product.id} onClick={() => setSelected(product)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && setSelected(product)}>
        <td>{modelCell}</td>
        {columns.own && <td>{ownCell}</td>}
        {columns.competitor && <td>{competitorCell}</td>}
        {columns.difference && <td>{differenceCell}</td>}
        {columns.status && <td>{statusCell}</td>}
      </tr>
    );
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">ЦТО</div>
        <div className="header-copy">
          <p className="eyebrow">Мониторинг рынка</p>
          <h1>Цены конкурентов</h1>
        </div>
        <div className="header-actions">
          <button className="secondary-button" onClick={() => setDark((value) => !value)}>{dark ? "Светлая тема" : "Тёмная тема"}</button>
          <button className="primary-button" onClick={() => void handleStartCollection()} disabled={startingJob || jobActive}>
            {startingJob ? "Запускаем" : jobActive ? jobLabel(job) : "Запустить сбор"}
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
          <div className="schedule-card"><span>Автоматический сбор</span><strong>{scheduleLabel(schedule)}</strong></div>
        </section>

        {job && (
          <section className={`job-banner ${job.status}`} aria-live="polite">
            <div><strong>{jobLabel(job)}</strong><span>{job.summary?.succeeded ?? job.observations ?? 0} цен получено · {job.summary?.failed ?? failedAttempts.length} ошибок</span></div>
            <span className="job-time">{job.finishedAt ? formatDate(job.finishedAt) : "Обновляем состояние"}</span>
            {failedAttempts.length > 0 && <details><summary>Показать ошибки источников</summary>{failedAttempts.slice(0, 5).map((attempt) => <p key={attempt.id}>{attempt.source.name} · {attempt.errorMessage ?? attempt.errorCode ?? "Источник недоступен"}</p>)}</details>}
          </section>
        )}

        <section className="metrics" aria-label="Сводка мониторинга">
          <article><span>Обязательные модели</span><strong>{summary.required}</strong><small>из задания</small></article>
          <article><span>Есть хотя бы одна цена</span><strong>{dashboardStats.withAnyPrice}</strong><small>из {summary.required}</small></article>
          <article><span>Можно сравнить</span><strong>{dashboardStats.compared}</strong><small>есть обе цены</small></article>
          <article><span>Наша цена ниже</span><strong>{dashboardStats.better}</strong><small>по валидным данным</small></article>
          <article><span>Точные источники</span><strong>{summary.exactOffers}</strong><small>допущены к сбору</small></article>
          <article><span>Нужно проверить</span><strong>{summary.reviewOffers}</strong><small>не влияют на сравнение</small></article>
        </section>

        <section className="catalog-panel">
          <div className="panel-heading">
            <div><h2>Таблица сравнения</h2><p>Показано {visibleProducts.length} позиций · нажмите на модель для истории и ручного ввода</p></div>
            <div className="panel-actions">
              <a className="export-button" href={priceExportUrl}>Скачать CSV</a>
              <details className="column-picker"><summary>Столбцы</summary><div>{([['own', 'Наша цена'], ['competitor', 'Конкурент'], ['difference', 'Разница'], ['status', 'Состояние']] as Array<[ColumnKey, string]>).map(([key, label]) => <label key={key}><input type="checkbox" checked={columns[key]} onChange={() => setColumns((value) => ({ ...value, [key]: !value[key] }))} />{label}</label>)}</div></details>
              <button className="refresh-button" onClick={() => void refresh()} disabled={loading}>{loading ? "Обновление" : "Обновить"}</button>
            </div>
          </div>

          <div className="filters">
            <label className="search-field"><span>Поиск</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Модель или артикул" /></label>
            <label><span>Часть каталога</span><select value={scope} onChange={(event) => setScope(event.target.value as ScopeFilter)}><option value="required">29 обязательных</option><option value="component">Компоненты комплекта</option><option value="additional">Дополнительные</option><option value="all">Все товары</option></select></label>
            <label><span>Данные</span><select value={dataFilter} onChange={(event) => setDataFilter(event.target.value as DataFilter)}><option value="all">Все состояния</option><option value="compared">Есть сравнение</option><option value="partial">Только одна цена</option><option value="missing">Нет цен</option></select></label>
            <label><span>Сопоставление</span><select value={matchFilter} onChange={(event) => setMatchFilter(event.target.value as MatchFilter)}><option value="all">Все источники</option><option value="exact">Точное</option><option value="review">Требует проверки</option><option value="without-offers">Без источников</option></select></label>
            <label><span>Сортировка</span><select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}><option value="priority">По приоритету</option><option value="name">По названию</option><option value="difference">По разнице цен</option><option value="freshness">Сначала свежие</option></select></label>
          </div>

          {error && <div className="error-state"><strong>Ошибка подключения</strong><p>{error}</p><button className="secondary-button" onClick={() => void refresh()}>Попробовать снова</button></div>}
          {loading && <div className="loading-state"><div className="spinner"></div><p>Загружаем цены из базы</p></div>}
          {!loading && !error && visibleProducts.length === 0 && <div className="empty-state"><strong>Ничего не найдено</strong><p>Измените поисковый запрос или фильтры.</p></div>}

          {!loading && !error && visibleProducts.length > 0 && (
            <>
              <div className="table-wrap desktop-table"><table><thead><tr><th>Модель</th>{columns.own && <th>Наша цена</th>}{columns.competitor && <th>Конкурент</th>}{columns.difference && <th>Разница</th>}{columns.status && <th>Состояние</th>}</tr></thead><tbody>{visibleProducts.map((product) => productRow(product))}</tbody></table></div>
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

            {selected.bundleParts.length > 0 && <section className="drawer-section"><h3>Состав комплекта</h3><p className="muted">Откройте оба компонента и внесите цены из одного предложения продавца. После второй цены сумма появится у комплекта автоматически.</p>{selected.bundleParts.map((part) => <button type="button" className="component" key={part.componentProduct.id} onClick={() => { const component = products.find((product) => product.id === part.componentProduct.id); if (component) setSelected(component); }}><strong>{part.componentProduct.name}</strong><span>{part.componentProduct.article ?? "Артикул не указан"} · {part.quantity} шт.</span></button>)}{comparisonMap.get(selected.id)?.bundleStatus?.ready ? <div className="notice success">Комплект рассчитан по двум ценам одного продавца</div> : <div className="notice">{bundleStatusLabel(comparisonMap.get(selected.id)?.bundleStatus?.exclusionReason ?? "incomplete_bundle")}</div>}</section>}

            {selected.catalogScope === "component" && <div className="notice">Укажите цену из одного и того же предложения продавца для обоих компонентов комплекта. Название продавца и ссылку сохраните в подтверждении цены.</div>}

            <section className="drawer-section">
              <div className="section-heading"><div><h3>История цен</h3><p>Каждый сбор сохраняется отдельной записью</p></div><span className="count-badge">{history?.total ?? 0}</span></div>
              {historyLoading && <div className="inline-loading"><div className="spinner"></div>Загружаем историю</div>}
              {!historyLoading && history?.items.length === 0 && <p className="muted">Истории пока нет. Запустите сбор или внесите цену вручную.</p>}
              <div className="history-list">{history?.items.map((entry) => <article className={`history-item ${entry.reliability}`} key={entry.id}><div><strong>{formatPrice(entry.normalizedPrice ?? entry.rawPrice)}</strong><span>{entry.offer.seller.displayName} · {formatDate(entry.receivedAt)}</span></div><div className="history-status"><span className={`method-badge ${entry.method}`}>{entry.method === "manual" ? "Вручную" : "Автоматически"}</span><small>{observationStatus(entry)}</small></div>{entry.exclusionReason && <p>Причина исключения · {entry.exclusionReason}</p>}</article>)}</div>
            </section>

            <section className="drawer-section manual-section">
              <div className="section-heading"><div><h3>Внести цену вручную</h3><p>Запись будет явно отмечена и пройдёт те же проверки надёжности</p></div></div>
              {selected.bundleParts.length > 0 ? <div className="notice">Цена комплекта напрямую не вводится. Внесите отдельно цены двух компонентов из предложения одного продавца.</div> : selected.offers.length === 0 ? <div className="notice">Для ручного ввода сначала нужен источник товара.</div> : (
                <form className="manual-form" onSubmit={(event) => void handleManualSubmit(event)}>
                  <label><span>Источник</span><select value={manual.offerId} onChange={(event) => setManual((value) => ({ ...value, offerId: event.target.value }))}>{selected.offers.map((offer) => <option value={offer.id} key={offer.id}>{offer.seller.displayName} · {matchLabel(offer.matchStatus)}</option>)}</select></label>
                  <div className="form-row"><label><span>Цена в рублях</span><input required inputMode="decimal" value={manual.rawPrice} onChange={(event) => setManual((value) => ({ ...value, rawPrice: event.target.value }))} placeholder="95000" /></label><label><span>Тип цены</span><select value={manual.priceType} onChange={(event) => setManual((value) => ({ ...value, priceType: event.target.value as ManualObservationInput["priceType"] }))}><option value="retail">Розничная</option><option value="rrp">Рекомендованная</option><option value="sale">Со скидкой</option><option value="quote">По запросу</option><option value="unknown">Не указано</option></select></label></div>
                  <label><span>Наличие</span><input value={manual.stockStatus} onChange={(event) => setManual((value) => ({ ...value, stockStatus: event.target.value }))} placeholder="В наличии или под заказ" /></label>
                  <label><span>Подтверждение цены</span><textarea value={manual.evidenceText} onChange={(event) => setManual((value) => ({ ...value, evidenceText: event.target.value }))} placeholder="Где и когда увидели цену" /></label>
                  {manualMessage && <div className={`form-message ${manualMessage.tone}`}>{manualMessage.text}</div>}
                  <button className="primary-button" type="submit" disabled={manualSaving}>{manualSaving ? "Сохраняем" : "Сохранить цену"}</button>
                </form>
              )}
            </section>

            <section className="drawer-section">
              <div className="section-heading"><div><h3>Исследованные источники</h3><p>Карточки для автоматического и ручного сбора</p></div></div>
              {selected.offers.length === 0 ? <p className="muted">Для этой позиции источники пока не исследованы.</p> : selected.offers.map((offer) => <article className="offer-card" key={offer.id}><div className="offer-title"><strong>{offer.seller.displayName}</strong><span className={`match-badge ${offer.matchStatus}`}>{matchLabel(offer.matchStatus)}</span></div><p>{offer.matchReason ?? "Пояснение не указано"}</p>{offer.source.sourceType === "manual" ? <span className="muted">Источник заполняется вручную</span> : <a href={offer.competitorUrl} target="_blank" rel="noreferrer">Открыть источник</a>}</article>)}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

export default App;
