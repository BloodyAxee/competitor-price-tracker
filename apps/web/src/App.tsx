import { useEffect, useMemo, useState } from "react";
import { loadCatalog } from "./api";
import type { CatalogSummary, Product } from "./types";

type ScopeFilter = "all" | "required" | "additional";
type MatchFilter = "all" | "exact" | "review" | "without-offers";
type SortKey = "name" | "scope" | "offers";

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

function App() {
  const [summary, setSummary] = useState(initialSummary);
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Product | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [match, setMatch] = useState<MatchFilter>("all");
  const [sort, setSort] = useState<SortKey>("name");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark");

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSummary, catalog] = await loadCatalog();
      setSummary(nextSummary);
      setProducts(catalog.items);
    } catch {
      setError("Не удалось получить каталог. Проверьте, что API и Docker запущены.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  const visibleProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("ru-RU");
    return products
      .filter((product) => scope === "all" || product.catalogScope === scope)
      .filter((product) => {
        if (match === "all") return true;
        if (match === "without-offers") return product.offers.length === 0;
        return product.offers.some((offer) => offer.matchStatus === match);
      })
      .filter((product) => {
        if (!normalizedQuery) return true;
        return `${product.name} ${product.article ?? ""}`
          .toLocaleLowerCase("ru-RU")
          .includes(normalizedQuery);
      })
      .sort((left, right) => {
        if (sort === "offers") return right.offers.length - left.offers.length;
        if (sort === "scope") return left.priority - right.priority || left.name.localeCompare(right.name, "ru");
        return left.name.localeCompare(right.name, "ru");
      });
  }, [products, query, scope, match, sort]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">ЦТО</div>
        <div className="header-copy">
          <p className="eyebrow">Прототип мониторинга</p>
          <h1>Каталог и источники цен</h1>
        </div>
        <div className="header-actions">
          <button className="secondary-button" onClick={() => setDark((value) => !value)}>
            {dark ? "Светлая тема" : "Тёмная тема"}
          </button>
          <button className="primary-button" disabled title="Сборщики цен подключаются на следующем этапе">
            Запустить сбор
          </button>
        </div>
      </header>

      <main>
        <section className="intro-row">
          <div>
            <div className="stage-pill">Этап каталога</div>
            <h2>Товары уже загружены в PostgreSQL</h2>
            <p>
              Здесь можно проверить состав каталога, собственные карточки и найденные источники.
              Цены появятся после подключения адаптеров сбора.
            </p>
          </div>
          <button className="refresh-button" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Обновление" : "Обновить данные"}
          </button>
        </section>

        <section className="metrics" aria-label="Сводка каталога">
          <article><span>Всего товаров</span><strong>{summary.total}</strong></article>
          <article><span>Обязательные</span><strong>{summary.required}</strong></article>
          <article><span>Дополнительные</span><strong>{summary.additional}</strong></article>
          <article><span>С нашей ссылкой</span><strong>{summary.ownUrls}</strong></article>
          <article><span>Точные источники</span><strong>{summary.exactOffers}</strong></article>
          <article><span>Нужно проверить</span><strong>{summary.reviewOffers}</strong></article>
        </section>

        <section className="catalog-panel">
          <div className="panel-heading">
            <div>
              <h2>Каталог</h2>
              <p>Показано {visibleProducts.length} из {summary.total}</p>
            </div>
            <div className="status-key"><span></span> Цены ещё не собраны</div>
          </div>

          <div className="filters">
            <label className="search-field">
              <span>Поиск</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Модель или артикул" />
            </label>
            <label>
              <span>Часть каталога</span>
              <select value={scope} onChange={(event) => setScope(event.target.value as ScopeFilter)}>
                <option value="all">Все товары</option>
                <option value="required">29 обязательных</option>
                <option value="additional">238 дополнительных</option>
              </select>
            </label>
            <label>
              <span>Сопоставление</span>
              <select value={match} onChange={(event) => setMatch(event.target.value as MatchFilter)}>
                <option value="all">Все статусы</option>
                <option value="exact">Точное совпадение</option>
                <option value="review">Требует проверки</option>
                <option value="without-offers">Источники не найдены</option>
              </select>
            </label>
            <label>
              <span>Сортировка</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                <option value="name">По названию</option>
                <option value="scope">По приоритету</option>
                <option value="offers">По числу источников</option>
              </select>
            </label>
          </div>

          {error && <div className="error-state"><strong>Ошибка подключения</strong><p>{error}</p></div>}
          {loading && <div className="loading-state"><div className="spinner"></div><p>Загружаем каталог из базы</p></div>}
          {!loading && !error && visibleProducts.length === 0 && (
            <div className="empty-state"><strong>Ничего не найдено</strong><p>Измените поисковый запрос или фильтры.</p></div>
          )}

          {!loading && !error && visibleProducts.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Модель</th>
                    <th>Каталог</th>
                    <th>Наша цена</th>
                    <th>Цена конкурента</th>
                    <th>Источники</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleProducts.map((product) => {
                    const exact = product.offers.some((offer) => offer.matchStatus === "exact");
                    return (
                      <tr key={product.id} onClick={() => setSelected(product)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && setSelected(product)}>
                        <td className="model-cell"><strong>{product.name}</strong><span>{product.article ?? "Артикул не указан"}</span></td>
                        <td><span className={`scope-badge ${product.catalogScope}`}>{scopeLabel(product.catalogScope)}</span></td>
                        <td><span className="missing-value">Не собрано</span></td>
                        <td><span className="missing-value">Не собрано</span></td>
                        <td><strong>{product.offers.length}</strong><span className="cell-note">карточек</span></td>
                        <td>{product.offers.length ? <span className={`match-badge ${exact ? "exact" : "review"}`}>{exact ? "Точное" : "Проверка"}</span> : <span className="match-badge none">Нет источника</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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

            {selected.bundleParts.length > 0 && <section className="drawer-section"><h3>Состав комплекта</h3>{selected.bundleParts.map((part) => <div className="component" key={part.componentProduct.id}><strong>{part.componentProduct.name}</strong><span>{part.componentProduct.article} · {part.quantity} шт.</span></div>)}</section>}

            <section className="drawer-section">
              <h3>Найденные источники</h3>
              {selected.offers.length === 0 ? <p className="muted">Для этой позиции источники пока не исследованы.</p> : selected.offers.map((offer) => (
                <article className="offer-card" key={offer.id}>
                  <div className="offer-title"><strong>{offer.seller.displayName}</strong><span className={`match-badge ${offer.matchStatus}`}>{matchLabel(offer.matchStatus)}</span></div>
                  <p>{offer.matchReason}</p>
                  <a href={offer.competitorUrl} target="_blank" rel="noreferrer">Открыть источник</a>
                </article>
              ))}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

export default App;
