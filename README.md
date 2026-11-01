# competitor-price-tracker

Прототип системы мониторинга цен конкурентов для centr-to.ru на PostgreSQL 18, NestJS 12, Prisma 7, React 18 и Docker Compose.

План реализации и контрольные точки: [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md).

Правила для coding/review-моделей OpenAI: [AGENTS.md](AGENTS.md).

Запуск и устройство PostgreSQL: [docs/DATABASE.md](docs/DATABASE.md).

## Быстрый запуск

1. Создайте локальный `.env` по примеру `.env.example` и задайте собственный пароль PostgreSQL.
2. Запустите Docker Desktop.
3. В корне репозитория выполните:

   ```powershell
   docker compose up -d --build
   ```

4. Откройте веб-интерфейс: <http://localhost:5173>

API доступен по адресу <http://localhost:3000>, проверка состояния — <http://localhost:3000/health>.

Остановить сервисы без удаления данных:

```powershell
docker compose stop
```

Посмотреть состояние контейнеров:

```powershell
docker compose ps
```

Проверить правила цен и отказоустойчивость сборщика в Python 3.13:

```powershell
docker run --rm -v "${PWD}/collector:/app" -w /app -e PYTHONPATH=/app/src python:3.13-slim python -m unittest discover -s tests -v
```

## API сбора

- `POST /api/collection-jobs` — поставить ручной сбор в очередь
- `GET /api/collection-jobs` — список заданий и их статусы
- `GET /api/collection-jobs/:id` — попытки и ошибки конкретного задания
- `GET /api/comparisons` — текущие надёжные цены и разница
- `GET /api/products/:id/history` — append-only история товара
- `GET /api/export.csv` — UTF-8 CSV со всей историей цен конкурентов в формате задания
- `POST /api/manual-observations` — добавить проверенную ручную цену
- `GET /api/collection-schedule` — активное расписание и часовой пояс

## Что уже работает

- forward-only миграции и схема PostgreSQL 18
- идемпотентный импорт `modeli.csv` и `modeli-dop.csv`
- 267 товаров, включая 29 обязательных и 238 дополнительных
- собственные ссылки, состав комплекта и 50 исследованных карточек конкурентов
- API каталога и сводной статистики
- адаптивный веб-интерфейс с поиском, фильтрами, сортировкой и карточкой товара
- каркас Python-сборщика с очередью PostgreSQL, ограниченными повторами и изоляцией ошибок источников
- HTTP-адаптер точной модели T300/380 для `si-tools.ru` с проверкой артикула и структурированной цены
- HTTP-адаптер собственной карточки T300/380 на `centr-to.ru` с проверкой ключевых характеристик
- API заданий, текущего сравнения, append-only истории и проверенного ручного ввода
- CSV-выгрузка с точными столбцами задания, ручным методом и пометкой надёжности
- ежедневное задание по `COLLECTION_CRON` в часовом поясе `APP_TIMEZONE` без дублей за день

Собственная и конкурентная цены T300 доступны в таблице сравнения. Из веб-интерфейса можно запустить сбор, открыть append-only историю модели и добавить явно отмеченную ручную цену. Остальные источники честно показывают `Не собрано` до подключения следующих точных адаптеров.
