# Bilky Automation v4.1 — Multi-user Architecture & Technical Specification

**Статус:** Target architecture / рабочее ТЗ  
**Версия:** 4.1  
**Язык документа:** русский  
**Исходный репозиторий:** `nikmad-ops/bilky_v1`  
**Назначение:** описание целевой multi-user архитектуры Bilky Automation простым языком, чтобы новый участник команды, включая стажёра без опыта DevOps, мог понять систему, безопасно работать с ней и развивать её.

> Этот документ описывает целевую архитектуру v4.1. Он не является описанием legacy-архитектуры. По состоянию на 08.10.2026 Nik, Alena и Irakli переведены на общий v4.1 Control Plane и общий GitHub execution layer.

---

## 1. Для кого этот документ

Документ рассчитан на человека, который:

- умеет пользоваться GitHub на базовом уровне;
- может читать простой JavaScript, YAML и логи, но не обязан быть DevOps-инженером;
- раньше не работал с Cloudflare Workers, GitHub Actions, Airtop, KV и browser automation;
- должен понять не только **что делает код**, но и **зачем архитектура устроена именно так**.

Главная задача документа — убрать зависимость от знаний «в голове» одного человека. После чтения стажёр должен понимать:

1. что такое Bilky Automation;
2. какие сервисы участвуют в работе;
3. кто за что отвечает;
4. как проходит обычный Morning/Evening;
5. что происходит при сбоях;
6. где смотреть логи;
7. какие изменения безопасны, а какие опасны;
8. как система должна масштабироваться с 3 пользователей до десятков и затем до 100+.


### Текущее production-состояние

- Nik, Alena и Irakli работают через v4.1;
- каждому пользователю соответствует отдельный GitHub Environment и Airtop profile;
- legacy scheduled dispatch для всех трёх отключён;
- operational non-working days хранятся в Cloudflare D1 `bilky-app`, таблица `non_working_days`;
- scheduler проверяет non-working day до создания GitHub/Airtop job;
- Status использует те же данные D1 и показывает такой день как non-working;
- Irakli не имеет отдельного Telegram interface; его пользовательские уведомления маршрутизируются через конфигурацию Alena.

---

## 2. Глоссарий

### Bilky
Внешняя система учёта рабочего времени. Именно в Bilky нужно зарегистрировать Morning или Evening.

**В нашем проекте:** это целевая система, в которой автоматизация реально нажимает Clock и получает фактическое время регистрации.

### Morning / Evening
Два бизнес-действия:

- **Morning** — начало рабочего дня;
- **Evening** — конец рабочего дня.

### Clock
Кнопка в Bilky, которая создаёт фактическую регистрацию времени.

**Важно:** нажатие считается подтверждённым только если Bilky вернул успешный HTTP 200 и/или на странице появился факт времени.

### Fact
Фактическое время, записанное Bilky, например `08:29:41`.

Пользователю обычно показываем только часы и минуты: `08:29`.

### Control Plane
«Диспетчер» системы. Он сам не нажимает кнопку в Bilky. Он решает:

- кого запускать;
- когда запускать;
- Morning или Evening;
- разрешён ли ручной запуск;
- не был ли такой запуск уже создан.

**В нашем случае:** Control Plane реализуется в Cloudflare Worker.

### Cloudflare Worker
Небольшая серверная программа, работающая в инфраструктуре Cloudflare.

**В нашем случае:** принимает cron-события, Telegram-команды и создаёт GitHub workflow runs.

### Cron
Расписание, которое периодически запускает Worker.

**В нашем случае:** Worker проверяет, нужно ли создать Morning/Evening job для конкретного пользователя.

### GitHub Actions
Сервис GitHub для запуска автоматических задач.

**В нашем случае:** GitHub Actions является главным execution engine — именно там живёт логика одного Morning/Evening job, retries, анализ результата, Telegram notification и diagnostics.

### Workflow
YAML-файл GitHub Actions, который описывает последовательность шагов.

**В нашем случае:** основной workflow v4.1 выполняет один логический Morning или Evening для одного пользователя.

### Job
Один логический запуск задачи.

Пример:

> Nik + 05.10.2026 + Morning = один job.

Job может содержать много попыток, но это всё равно одна бизнес-операция.

### Attempt
Одна попытка открыть Airtop, войти в Bilky и получить требуемый результат.

**В v4.1:** один Cycle содержит максимум 5 attempts.

### Cycle
Группа из максимум 5 попыток.

**В v4.1:** максимум 3 cycles, то есть максимум 15 attempts на один Morning/Evening job.

### Recovery
Автоматическое продолжение работы после временной проблемы.

Например: первые 5 попыток не прошли, но система не сдаётся, а начинает Cycle 2.

### Terminal state
Финальное состояние job, после которого система больше ничего не делает.

Основные terminal states:

- `SUCCESS`;
- `ALREADY_DONE`;
- `REQUIRES_ATTENTION` после исчерпания всех 15 попыток.

### Idempotency
Защита от повторного создания одной и той же операции.

Простой пример: scheduler работает каждые 5 минут, но Morning для Nik за одну дату должен быть создан только один раз.

### Duplicate protection
Защита от повторного нажатия Clock.

Перед каждым нажатием система проверяет, нет ли уже фактического времени. Если есть — возвращает `already_done` и ничего не нажимает.

### Airtop
Сервис удалённого браузера.

**В нашем случае:** Airtop создаёт browser session с ES proxy, через которую Playwright открывает Bilky.

### Airtop profile
Постоянный профиль браузера.

**В нашем случае:** отдельный профиль на каждого пользователя, например `bilky-nik`, `bilky-alena`, `bilky-irakli`.

### Airtop API key
Секретный ключ доступа к Airtop.

**В нашем случае:** отдельный ключ на каждого пользователя.

### Playwright
Библиотека для управления браузером программно.

**В нашем случае:** Playwright подключается к браузеру Airtop и работает с Bilky DOM.

### DOM
Структура HTML-страницы, которую видит браузер.

**В нашем случае:** мы ищем структурные элементы страницы Bilky: login fields, Workshift link, date container, Clock button, фактическое время.

### Selector
Правило поиска элемента в DOM.

Пример: `#password` — поле пароля.

### Dashboard detection
Определение, что Bilky уже успешно авторизовал пользователя и открыл Dashboard.

**Важно:** нельзя полагаться только на визуальную видимость меню. В реальном DOM audit мы подтвердили, что Workshift link может существовать в DOM, но быть скрытым.

### HTTP 200
Код успешного HTTP-ответа.

**В нашем случае:** ответ `clock-hour HTTP 200` является сильным доказательством, что Bilky принял нажатие Clock.

### CAPTCHA / Cloudflare challenge
Защитная проверка сайта.

**Ключевое правило Bilky:** мы **не ждём CAPTCHA дольше**. Если конкретная Airtop session быстро не проходит challenge, попытка заканчивается, session закрывается, через 3 минуты создаётся новая session.

### Session budget
Максимальное полезное время одной Airtop browser session.

**В нашем случае:** 28 секунд. Его нельзя увеличивать без отдельного решения, основанного на данных.

### Post-login timeout
Сколько ждём после отправки login form появления понятного состояния.

**В нашем случае:** 8 секунд.

### Retry
Повтор после неуспешной попытки.

**В нашем случае:** стандартный интервал между попытками — 3 минуты.

### KV
Cloudflare Key-Value storage.

**В нашем случае:** лёгкая память Control Plane: idempotency, состояние dispatch, request IDs и временные operational states.

### Secret
Конфиденциальное значение: пароль, NIF, API key, Telegram bot token, GitHub token.

**Правило:** секреты нельзя хранить в коде, KV как обычный текст, логах или diagnostics.

### GitHub Environment
Изолированная область GitHub, в которой можно хранить secrets и настройки конкретного пользователя.

**Целевое применение:** `client-nik`, `client-alena`, `client-irakli` с одинаковыми именами secrets.

### Artifact
Файл, который GitHub Actions сохраняет после run.

**В нашем случае:** diagnostics, run result, attempt history, forensic snapshot.

### Forensic
Диагностический снимок состояния страницы при непонятной ошибке.

**В нашем случае:** DOM fingerprint, безопасный HTML snapshot, ограниченная network metadata и screenshot без секретных данных.

### Runbook
Короткая инструкция «что делать, если что-то сломалось».

### ADR — Architecture Decision Record
Короткая запись, почему принято конкретное архитектурное решение.

Пример: почему session budget равен 28 секундам или почему retry живёт внутри одного GitHub run.

### Concurrency
Правило, которое не позволяет одновременно выполнять конфликтующие jobs.

**В нашем случае:** для одного пользователя и одного action одновременно должен работать только один v4.1 job.

---

## 3. Bilky за 60 секунд: что происходит в обычный день

Пример Morning для Nik.

1. Cloudflare Worker по расписанию видит, что наступило время Morning.
2. Worker проверяет, не создавался ли уже Morning job для Nik сегодня.
3. Если нет — Worker запускает GitHub workflow.
4. GitHub получает параметры: пользователь, Morning/Evening, Airtop profile, режим запуска.
5. GitHub создаёт Airtop browser session.
6. Airtop открывает Bilky через ES proxy.
7. Код проверяет: пользователь уже на Workshift, на Dashboard или на Login.
8. Если Bilky просит login — вводятся NIF и password.
9. После login система определяет Dashboard по URL и DOM.
10. Открывается Workshift.
11. Перед нажатием Clock проверяется, нет ли уже фактического времени.
12. Если факт уже есть — ничего не нажимаем и завершаем job как `already_done`.
13. Если факта нет — нажимаем Clock.
14. Ждём ответ Bilky.
15. При HTTP 200 читаем фактическое время.
16. GitHub отправляет Telegram success.
17. Job завершён.

Если попытка неуспешна, запускается recovery: новая Airtop session через 3 минуты.

---

## 4. Цели v4.1 Multi-user

v4.1 должна решить пять задач.

### 4.1 Один код для всех пользователей
Nik, Alena, Irakli и будущие пользователи должны использовать один production codebase и один master workflow.

Нельзя поддерживать три почти одинаковые копии кода.

### 4.2 Изоляция пользователей
Несмотря на общий код, у каждого пользователя должны быть отдельно:

- Bilky credentials;
- Airtop API key;
- Airtop profile;
- Telegram routing;
- state и idempotency keys;
- run history.

### 4.3 Автоматическое восстановление
Один временный сбой не должен превращаться в пользовательское `ERROR`.

v4.1 должна самостоятельно пройти до 3 cycles × 5 attempts.

### 4.4 Понятное продуктовое поведение
Пользователь должен видеть:

- успех;
- спокойное сообщение о задержке;
- отсутствие технического мусора.

Технические детали остаются у admin и в diagnostics.

### 4.5 Подготовка к масштабированию
Архитектура должна без переписывания базовых принципов перейти от 3 пользователей к 10, 30 и 100+.

---

## 5. Архитектура верхнего уровня

```mermaid
flowchart LR
    TG[Telegram] --> CF[Cloudflare Control Plane]
    CRON[Cloudflare Cron] --> CF
    CF --> KV[Cloudflare KV]
    CF --> GH[GitHub Actions<br/>bilky_v1]
    GH --> AT[Airtop Browser]
    AT --> BK[Bilky]
    GH --> ART[GitHub Artifacts]
    GH --> TG
```

Простыми словами:

- **Cloudflare** решает, когда и кого запускать.
- **GitHub Actions** выполняет бизнес-задачу и владеет recovery.
- **Airtop** предоставляет браузер.
- **Bilky** является системой назначения.
- **KV** не даёт запускать одно и то же повторно.
- **Telegram** — интерфейс пользователя и администратора.
- **Artifacts** — техническая история и диагностика.

---

## 6. Компоненты и ответственность

| Компонент | Продукт | Что делает | Чего делать не должен |
|---|---|---|---|
| Control Plane | Cloudflare Worker | Scheduler, Manual Run, Status dispatch, permissions, idempotency | Не должен сам управлять браузером Bilky |
| Scheduler | Cloudflare Cron | Периодически проверяет, пора ли запускать job | Не должен делать retries отдельных browser attempts |
| State | Cloudflare KV | Хранит dispatch/idempotency/temporary state | Не хранит Bilky password |
| Execution Engine | GitHub Actions | Выполняет один Morning/Evening job целиком | Не создаёт второй независимый job для того же действия |
| Browser Core | Node.js + Playwright | Login, DOM, Workshift, Clock, fact | Не решает расписание |
| Browser Provider | Airtop | Создаёт remote browser + ES proxy | Не определяет бизнес-успех |
| Target System | Bilky | Хранит реальный факт рабочего времени | Не является нашим state store |
| Notifications | Telegram | User/admin interface | Не определяет успешность Bilky |
| Diagnostics | GitHub Artifacts | Логи, attempts, forensic | Не должны содержать secrets |
| Secrets | GitHub Environments / Cloudflare Secrets | Credentials и API keys | Не должны попадать в KV или repo |

---

## 7. Графическая схема v4.1 Multi-user

```mermaid
flowchart TB
    subgraph Users["Users / Telegram"]
      ADMIN[Admin: Nik]
      ALENA[Alena]
      IRAKLI[Irakli<br/>ordinary user; recipient is configured by secrets]
    end

    subgraph CF["Cloudflare"]
      CP[Bilky v4.1 Control Plane]
      REG[Client Registry<br/>non-secret metadata]
      KV[(KV State)]
      CRON[Cron]
    end

    subgraph GH["GitHub: nikmad-ops/bilky_v1"]
      WF[workshift-v4.1-master.yml]
      CORE[production-core.js]
      STATUS[status-report.yml]
      ART[(Artifacts)]
      ENVN[Environment client-nik]
      ENVA[Environment client-alena]
      ENVI[Environment client-irakli]
    end

    subgraph AT["Airtop"]
      PN[bilky-nik]
      PA[bilky-alena]
      PI[bilky-irakli]
    end

    BK[Bilky]

    CRON --> CP
    ADMIN --> CP
    ALENA --> CP
    CP --> REG
    CP <--> KV
    CP --> WF
    CP --> STATUS

    ENVN --> WF
    ENVA --> WF
    ENVI --> WF
    WF --> CORE
    CORE --> PN
    CORE --> PA
    CORE --> PI
    PN --> BK
    PA --> BK
    PI --> BK
    WF --> ART
    WF --> ADMIN
    WF --> ALENA
```

---

## 8. Основные сценарии

### 8.1 Scheduled Morning / Evening

```mermaid
sequenceDiagram
    participant C as Cloudflare
    participant K as KV
    participant G as GitHub v4.1
    participant A as Airtop
    participant B as Bilky
    participant T as Telegram

    C->>K: Check idempotency
    K-->>C: Not dispatched
    C->>G: Start one logical shift job
    C->>K: Save dispatch state
    G->>A: Create browser session
    A->>B: Open Bilky
    B-->>A: Login / Dashboard / Workshift
    A->>B: Check existing fact
    alt Fact exists
        B-->>G: already_done
    else No fact
        A->>B: Click Clock
        B-->>G: HTTP 200 + fact
    end
    G->>T: Success notification
```

### 8.2 Manual Run

Manual Run выполняет ту же production-логику, что scheduled job.

Отличия:

- пользователь сам инициирует запуск через Telegram;
- обычное scheduled start window не блокирует manual run;
- weekend block остаётся;
- duplicate protection и recovery такие же;
- максимум 3 cycles × 5 attempts.

Права:

- **Nik/admin** — может запустить любого пользователя;
- **Alena** — может запустить Alena и Irakli;
- будущий обычный пользователь — только самого себя;
- Irakli прямой Telegram interface не получает.

### 8.3 Status

Status — отдельная операция.

Правила:

- Status не берётся из cache;
- Status запускает реальную read-only проверку Bilky;
- для Status может использоваться Airtop;
- Status не нажимает Clock;
- результат возвращается в Telegram;
- Status не должен менять Morning/Evening state.

---

## 9. Recovery: три цикла по пять попыток

Это главное изменение v4.1.

### 9.1 Общая модель

Один GitHub run содержит:

- Cycle 1: attempts 1–5;
- Cycle 2: attempts 6–10;
- Cycle 3: attempts 11–15.

Один GitHub run владеет всей операцией до terminal state.

```text
Morning Job
|
+-- Cycle 1
|   +-- Attempt 1
|   +-- wait 3 min
|   +-- Attempt 2
|   +-- ...
|   +-- Attempt 5
|
+-- User notification: delayed, continuing automatically
|
+-- Cycle 2
|   +-- Attempts 6..10
|
+-- Admin notification: final recovery cycle
|
+-- Cycle 3
|   +-- Attempts 11..15
|
+-- SUCCESS / ALREADY_DONE / REQUIRES_ATTENTION
```

### 9.2 Интервал

Между любыми двумя реальными неуспешными attempts — **3 минуты**.

Это относится и к границе циклов:

- attempt 5 → 3 минуты → attempt 6;
- attempt 10 → 3 минуты → attempt 11.

Никакой специальной длинной паузы между cycles нет.

### 9.3 CAPTCHA

CAPTCHA не получает дополнительного времени.

Правило:

1. текущая session быстро справилась — продолжаем;
2. session упёрлась в challenge — attempt заканчивается;
3. session закрывается;
4. через 3 минуты создаётся новая session.

**Запрещено:** увеличивать session budget или специально ждать CAPTCHA «ещё немного».

### 9.4 Session budget

Одна Airtop session: **28 секунд**.

Это отдельный лимит одного attempt, а не всего job.

### 9.5 Защита от повторного нажатия

Перед каждым attempt система заново проверяет факт.

Если Morning/Evening уже записан:

- статус `already_done`;
- кнопку не нажимаем;
- весь job немедленно завершается успешно.

Это критично, потому что между attempts Bilky мог уже принять предыдущий запрос или действие мог выполнить человек вручную.

### 9.6 Как реализовать 15 attempts без риска сломать browser core

Рекомендуемая реализация:

- внешний workflow считает `cycle=1..3`;
- внутри каждого cycle считает `attempt=1..5`;
- browser core по-прежнему получает local attempt `1..5`;
- workflow отдельно пишет `globalAttempt=1..15`.

Так мы не обязаны расширять проверку `ATTEMPT must be 1..5` внутри стабильного production core.

---

## 10. Временные окна

### 10.1 Принцип

В v4.1 поздний успешный результат лучше раннего отказа.

Окно не должно останавливать уже начатый recovery.

### 10.2 Target operational windows

Начальные значения v4.1:

- **Morning:** 07:55–09:30 Europe/Madrid;
- **Evening:** 16:30–18:05 Europe/Madrid.

Эти границы — operational guard, а не бизнес-ограничение.

Если job был создан внутри окна, он имеет право закончить Cycle 3 даже после конца окна.

### 10.3 Почему окно расширено

Максимальный recovery содержит до 14 интервалов по 3 минуты:

- только паузы могут занять до 42 минут;
- плюс создание Airtop sessions;
- плюс GitHub overhead;
- плюс Bilky response time.

Поэтому старые окна 07:55–08:25 и 16:30–17:00 недостаточны.

### 10.4 Idempotency важнее узкого окна

Расширение окна не должно создавать повторные jobs.

Для этого Control Plane хранит ключ вида:

`scheduled:{client}:{date}:{action}`

Если job уже создан, cron больше его не создаёт.

---

## 11. Telegram notifications

Все сообщения v4.1 — **на английском**.

Пользователь не должен видеть слова `ERROR`, HTTP codes, CAPTCHA, GitHub, Airtop или количество технических exceptions.

### 11.1 Success

`✅ Bilky for Alena 05.10.2026: Morning. Fact: 08:29`

### 11.2 После первого неуспешного cycle, 5 attempts

Пользователь + admin:

`Bilky for Alena: Morning is taking a little longer than usual. We’re continuing automatically. No action is required from you.`

После этого система продолжает Cycle 2.

### 11.3 После второго неуспешного cycle, 10 attempts

Только admin:

`⚠️ Bilky recovery for Alena: Morning is still in progress after 10 attempts. Final recovery cycle started.`

Пользователю второе промежуточное сообщение не отправляется.

### 11.4 После 15 неуспешных attempts

Пользователю:

`Bilky for Alena: Morning could not be confirmed automatically yet. No action is required from you.`

Admin:

`⚠️ Bilky for Alena: Morning requires attention. Automatic recovery exhausted after 15 attempts.`

### 11.5 Telegram failure не меняет результат Bilky

Если Clock успешно зарегистрирован, но Telegram API временно недоступен:

- Bilky job остаётся SUCCESS;
- повторно Clock не нажимаем;
- notification failure записываем отдельно.

---

## 12. DOM и определение состояния страницы

Browser core должен определять не «что визуально видно человеку», а реальное структурное состояние страницы.

Основные состояния:

- Login;
- Dashboard;
- Workshift;
- unresolved.

### 12.1 Login

Признаки:

- URL содержит `/auth/login`;
- существуют `#taxid` и `#password`.

### 12.2 Dashboard

Признаки:

- URL содержит `/employee/dashboard/` или `/employee/control/panel`;
- или Workshift link существует в DOM.

**Важно:** Workshift link не обязан быть visible.

### 12.3 Workshift

Основной признак:

- существует date container `#container_YYYY-MM-DD`.

### 12.4 Post-login timeout

После submit login form ждём понятное состояние максимум **8 секунд**.

Если за 8 секунд нет Dashboard/Workshift:

- снимаем forensic;
- attempt завершается;
- Airtop session закрывается;
- retry через 3 минуты.

---

## 13. Поиск нужной строки и Clock

Основная логика должна использовать структурные selectors, а не текст на конкретном языке.

Текущие ключевые элементы:

- `#container_${date}`;
- `tr`;
- `td.hr-container`;
- `input.clockpicker`;
- `a.clock`;
- `i.fe-clock[data-original-title]`;
- `.badge-success`.

Плановые `08:00` / `16:00` используются как fingerprint нужной строки, но система должна иметь структурный fallback, если на странице ровно один подходящий candidate.

---

## 14. Forensic и diagnostics

Diagnostics нужны не «на всякий случай», а чтобы следующий сбой дал новую информацию.

### 14.1 Когда собирать forensic

Например:

- post-login state unresolved;
- неожиданная структура страницы;
- Workshift не найден;
- непонятный challenge;
- Clock endpoint ведёт себя необычно.

### 14.2 Что сохранять

- reason;
- timestamp;
- URL без query/fragment;
- title;
- readyState;
- безопасный DOM fingerprint;
- количество нужных элементов;
- challenge indicators;
- ограниченную network metadata;
- sanitized DOM;
- screenshot без credentials;
- attempt/cycle metadata.

### 14.3 Что нельзя сохранять

- NIF;
- password;
- API keys;
- Telegram tokens;
- cookie values;
- Authorization headers;
- query strings с tokens;
- полный body text пользователя;
- заполненные login fields.

### 14.4 Важная задача до rollout v4.1

Текущий Nik pilot forensic должен быть дополнительно hardened:

- убрать `bodyTextSample`;
- очищать network URLs до origin + pathname;
- хранить только безопасные CAPTCHA summaries;
- гарантированно маскировать login fields на screenshot.

Это обязательная задача до массового rollout.

---

## 15. State ownership: где живёт какая информация

| Информация | Владелец |
|---|---|
| Расписание | Cloudflare Control Plane |
| Список пользователей, labels, profile names, permissions | Client Registry |
| Dispatch idempotency | Cloudflare KV |
| Один активный Morning/Evening job | GitHub Actions |
| Cycle/attempt execution | GitHub Actions |
| Browser session | Airtop |
| Реальный факт времени | Bilky |
| Technical diagnostics | GitHub Artifacts |
| Credentials | GitHub Environments / Cloudflare Secrets |
| Telegram UI routing | Cloudflare Control Plane |

Главное правило:

> одна сущность должна иметь одного понятного владельца.

Например, retries принадлежат GitHub job. Cloudflare не должен параллельно создавать свои retries того же attempt.

---

## 16. Multi-user model

Целевая v4.1 использует один codebase.

Для каждого пользователя нужен non-secret record:

```json
{
  "id": "alena",
  "label": "Alena",
  "githubEnvironment": "client-alena",
  "airtopProfile": "bilky-alena",
  "scheduled": true,
  "timezone": "Europe/Madrid"
}
```

Secrets в такой record не входят.

### 16.1 Минимальный набор полей

- `id` — стабильный технический ID;
- `label` — имя для Telegram;
- `githubEnvironment` — где лежат secrets;
- `airtopProfile` — Airtop browser profile;
- `scheduled` — участвует ли пользователь в cron;
- `permissions` — кто может Run/Status для этого пользователя;
- `telegram recipient configuration` — куда уходят пользовательские notifications; это конфигурация получателя, а не особый тип пользователя.

### 16.2 Независимость runs

Nik, Alena и Irakli могут иметь отдельные jobs.

Concurrency key:

`bilky-v4.1-{client_id}-{action}`

Это не даёт запустить два Morning одновременно для одного пользователя, но не мешает разным пользователям.

---

## 17. Telegram routing и permissions

### Admin / Nik

Может:

- Status любого пользователя;
- Manual Run любого пользователя;
- получать технические recovery alerts;
- получать terminal attention alerts.

### Alena

Может:

- Status Alena;
- Manual Run Alena;
- Manual Run Irakli;
- получать Alena notifications;
- получать Irakli notifications.

### Irakli

Irakli — **обычный самостоятельный пользователь**, а не специальный технический тип пользователя.

У него должны быть собственные:

- Bilky credentials;
- Airtop API key;
- Airtop profile;
- state/idempotency;
- run history;
- user configuration.

Получатель его обычных Telegram-сообщений задаётся **конфигурацией/secrets**, а не специальной логикой переадресации в browser/workflow code. Сейчас в Irakli client secrets в качестве client Telegram recipient используется чат Alena. Если в будущем заменить эти secrets на Telegram bot/chat Irakli, обычные сообщения должны начать приходить Irakli без изменения execution architecture.

Отдельно существует **делегирование прав управления** в Telegram Control Plane. Это не routing уведомлений и не делает Irakli «подпользователем» Alena.

Текущее подтверждённое делегирование:

- admin/Nik может управлять Nik, Alena и Irakli;
- Alena может сделать Manual Run для Alena или Irakli;
- текущая команда Status в интерфейсе Alena проверяет только Alena;
- admin Status позволяет выбрать Nik, Alena или Irakli.

Если будет принято решение дать Alena также Status для Irakli, это должно быть отдельным permission rule в Control Plane, а не технической переадресацией сообщений.

### Будущий обычный пользователь

По умолчанию:

- Status только себя;
- Run только себя;
- notifications только свои.

---

## 18. Secrets и безопасность

### 18.1 Текущее состояние

Сейчас credentials распределены по GitHub repositories/secrets и отдельным integrations.

Это работоспособно для пилота, но неудобно при росте пользователей.

### 18.2 Target v4.1

Один repository: `nikmad-ops/bilky_v1`.

Для каждого пользователя отдельный GitHub Environment:

- `client-nik`;
- `client-alena`;
- `client-irakli`.

В каждом Environment одинаковые имена secrets:

- `BILKY_NIF`;
- `BILKY_PASSWORD`;
- `AIRTOP_API_KEY`;
- при необходимости user-specific Telegram secrets.

Control Plane secrets отдельно в Cloudflare:

- GitHub token;
- Telegram bot tokens;
- webhook secrets.

### 18.3 Что нельзя делать

- hardcode password в JS/YAML;
- класть credentials в KV;
- печатать secrets в console;
- прикладывать credentials в artifact;
- передавать password через workflow input.

---

## 19. Airtop usage и контроль стоимости

Airtop — наиболее заметный переменный расход.

Правила:

1. отдельный API key и profile на пользователя;
2. одна попытка = одна полезная browser session;
3. session budget = 28 секунд;
4. после terminal success новых sessions быть не должно;
5. Status создаёт Airtop session только потому, что это реальная on-demand проверка;
6. не запускать live tests, если ответ можно получить из кода/logs;
7. static checks не должны использовать Airtop;
8. DOM audit должен запускаться только когда действительно нужна новая информация.

### 19.1 15 attempts — это максимальная страховка, а не нормальный расход

Нормальный job должен завершаться на ранних attempts.

Поэтому в diagnostics обязательно хранить:

- cycle;
- attempt;
- session duration;
- failure reason;
- terminal attempt.

Это позволит позже оптимизировать стоимость на реальных данных.

---

## 20. Типичные аварии

### 20.1 Airtop session не создалась

**Что означает:** проблема до открытия Bilky.

**Действие:** закрыть attempt, через 3 минуты новая session.

### 20.2 CAPTCHA / Cloudflare challenge

**Что означает:** конкретная session не прошла защиту.

**Действие:** не ждать дольше, завершить attempt, новая session через 3 минуты.

### 20.3 Login submit прошёл, но Dashboard не определён

**Что означает:** возможна проблема state detection или необычная страница.

**Действие:** 8 секунд → forensic → attempt failure → retry.

### 20.4 Dashboard есть, но Workshift link hidden

**Что означает:** нормальный UI case, подтверждённый реальным DOM audit.

**Действие:** использовать DOM presence / authenticated URL, а не `:visible`.

### 20.5 Clock нажали, но Bilky отвечает долго

**Что означает:** backend Bilky может отвечать медленно.

**Действие:** ждать только в рамках session budget. Если HTTP 200 получен — успех.

### 20.6 HTTP 200 получен, Telegram упал

**Что означает:** бизнес-действие успешно, notification нет.

**Действие:** не повторять Clock. Логировать notification failure отдельно.

### 20.7 5 attempts закончились

Это **не terminal error**.

**Действие:** отправить soft user message и начать Cycle 2.

### 20.8 10 attempts закончились

**Действие:** admin alert, начать Cycle 3.

### 20.9 15 attempts закончились

**Действие:** user soft message + admin requires attention. Job terminal.

---

## 21. Runbook: что делать при проблеме

### Ситуация A: пользователь говорит «нет сообщения»

1. открыть GitHub Actions;
2. найти job по client/date/action;
3. проверить, есть ли terminal success;
4. если Bilky success есть, проверить Telegram step;
5. не запускать Clock повторно только из-за Telegram.

### Ситуация B: job в recovery

1. посмотреть текущий cycle/attempt;
2. посмотреть последние failure reasons;
3. не вмешиваться вручную, если recovery ещё работает;
4. дождаться terminal state.

### Ситуация C: 15/15 exhausted

1. открыть `v4-attempts.ndjson`;
2. посмотреть повторяется ли одна причина;
3. открыть forensic artifact;
4. определить слой проблемы: Airtop / challenge / login / Dashboard / Workshift / Clock;
5. только после анализа решать, нужен ли live diagnostic run.

### Ситуация D: есть HTTP 200

Считать Bilky action успешным.

Нельзя делать повторный click из-за проблем с Telegram, parsing или artifact upload.

---

## 22. Как читать логи

Пример нормального success:

```text
Creating Airtop session
Airtop session ready
Opening direct Workshift URL
Bilky requested login
Submitting Bilky login
Dashboard detected
Workshift ready
CLICK morning
clock-hour HTTP 200
SUCCESS status=clicked fact=08:29:41
```

Что это значит:

- `Creating Airtop session` — запросили браузер;
- `session ready` — браузер создан;
- `Bilky requested login` — Bilky попросил credentials;
- `Submitting...` — отправили форму;
- `Dashboard detected` — login успешен;
- `Workshift ready` — нужная страница открыта;
- `CLICK morning` — реальное действие;
- `HTTP 200` — Bilky принял запрос;
- `fact=...` — фактическое время.

Пример challenge failure:

```text
CAPTCHA event: detected
CAPTCHA event: processing
session budget exceeded
```

Это означает:

> не «надо ждать дольше», а «эта session не справилась; нужна новая session».

---

## 23. Что нельзя делать

1. Не увеличивать 28 секунд «на всякий случай».
2. Не ждать CAPTCHA специально дольше.
3. Не создавать external retry в Cloudflare для attempts, которыми уже владеет GitHub job.
4. Не нажимать Clock повторно, если есть факт или HTTP 200 proof.
5. Не запускать Airtop только ради проверки архитектуры.
6. Не делать live Status многократно для теста.
7. Не менять selectors без DOM evidence.
8. Не использовать `:visible` как единственный признак Dashboard.
9. Не хранить secrets в logs/artifacts/KV.
10. Не считать Telegram failure бизнес-ошибкой Bilky.
11. Не мигрировать всех пользователей одновременно после непроверенного изменения.
12. Не добавлять новые архитектурные механизмы без ADR, если они меняют ownership/state/retry/security.

---

## 24. Как безопасно внести изменение

Рекомендуемый процесс.

### Шаг 1. Определить слой

Пример:

- schedule → Cloudflare;
- retry → GitHub workflow;
- login/DOM → production-core;
- notification → workflow/Telegram layer;
- credentials → GitHub Environment.

### Шаг 2. Проверить ADR

Если решение уже принято — не менять его случайно.

### Шаг 3. Изменить минимальную область

Не переписывать несколько компонентов, если проблема локальная.

### Шаг 4. Static validation

Проверить:

- JS syntax;
- YAML syntax;
- workflow references;
- required inputs;
- obvious secret names.

Static check не должен создавать Airtop session.

### Шаг 5. Проверка на Nik

Nik остаётся pilot user для новых архитектурных изменений.

### Шаг 6. Реальный production observation

Если изменение можно подтвердить ближайшим реальным Morning/Evening, лучше дождаться его, чем жечь Airtop отдельным тестом.

### Шаг 7. Rollout

После подтверждения:

1. Alena;
2. Irakli;
3. будущие пользователи.

### Шаг 8. Обновить документ / ADR

Если изменилось архитектурное правило — документация меняется в том же change set.

---

## 25. ADR — ключевые архитектурные решения

### ADR-001 — Один logical shift = один GitHub run

**Решение:** один Morning/Evening job владеет всеми retries.

**Почему:** внешний scheduler retry создаёт риск дублей и усложняет state.

### ADR-002 — Recovery = 3 cycles × 5 attempts

**Решение:** максимум 15 attempts.

**Почему:** пользовательский приоритет — получить успешный факт, даже если требуется больше времени.

### ADR-003 — Retry interval = 3 минуты

**Решение:** одинаковый интервал между любыми attempts.

**Почему:** уже принятая и понятная модель; не вводим adaptive delays без данных.

### ADR-004 — CAPTCHA не ждём дольше

**Решение:** если session быстро не проходит challenge, завершаем attempt.

**Почему:** по наблюдениям ожидание не улучшает шанс этой session, но увеличивает расход.

### ADR-005 — Airtop session budget = 28 секунд

**Решение:** не увеличивать без новых данных.

### ADR-006 — Post-login timeout = 8 секунд

**Решение:** если Dashboard/Workshift не определён за 8 секунд, forensic + retry.

### ADR-007 — Dashboard detection = URL + DOM presence

**Решение:** Workshift link не обязан быть visible.

**Причина:** реальный DOM audit показал hidden Workshift link при успешном Dashboard.

### ADR-008 — User-facing errors скрывают технические детали

**Решение:** пользователь не видит `ERROR after 5/5`, CAPTCHA, HTTP или GitHub details.

### ADR-009 — Status не кэшируется

**Решение:** Status — реальная on-demand read-only проверка.

### ADR-010 — Один codebase, secrets изолированы per user

**Решение:** `bilky_v1` — source of truth; credentials через отдельные GitHub Environments.

---

## 26. Масштабирование и roadmap

### 26.1 3 пользователя

Для Nik, Alena, Irakli достаточно:

- один Control Plane;
- один master repo;
- один workflow;
- Client Registry;
- KV state;
- отдельные GitHub Environments;
- отдельные Airtop profiles/API keys.

### 26.2 10–30 пользователей

Добавляются:

- более формализованный Client Registry;
- dashboard metrics по success rate / attempts / Airtop usage;
- более строгий observability;
- автоматический reporting по repeated failures;
- stagger scheduled starts, если нагрузка начинает конфликтовать.

### 26.3 100+ пользователей

v4.1 должна позволить расти без изменения основных принципов:

- один logical job;
- per-user isolation;
- retries внутри job;
- idempotency;
- secret isolation;
- diagnostics.

На этом этапе, вероятно, понадобится более формальный execution queue/concurrency control, но **queue не реализуем заранее**, пока реальные данные не покажут необходимость.

### 26.4 Следующий этап: Web Control Panel

Web UI не входит в v4.1.

Его нужно рассматривать следующим этапом.

Возможные функции:

- список пользователей;
- текущие statuses;
- Manual Run;
- run history;
- attempts/cycles;
- diagnostics links;
- Airtop credit statistics;
- permissions;
- schedule settings.

### 26.5 Обязательные задачи перед миграцией Alena и Irakli на v4.1

1. реализовать 3 cycles × 5 attempts в одном master workflow;
2. увеличить GitHub job timeout: текущих 35 минут недостаточно для 15 attempts;
3. реализовать soft Telegram notifications на границах cycles;
4. расширить operational Morning/Evening windows;
5. гарантировать, что end-of-window не останавливает уже начатый recovery;
6. harden forensic и убрать потенциально чувствительные данные;
7. создать per-user GitHub Environments;
8. сделать Client Registry multi-user;
9. проверить permissions/routing;
10. провести Nik pilot на реальных Morning/Evening;
11. после стабильного Nik — мигрировать Alena;
12. после Alena — Irakli.

---

# Приложение A. Целевой lifecycle одного job

```mermaid
stateDiagram-v2
    [*] --> SCHEDULED
    SCHEDULED --> RUNNING
    RUNNING --> SUCCESS: clicked / HTTP 200
    RUNNING --> SUCCESS: already_done
    RUNNING --> DELAYED: Cycle 1 exhausted
    DELAYED --> RECOVERING
    RECOVERING --> SUCCESS: Cycle 2 or 3 succeeds
    RECOVERING --> REQUIRES_ATTENTION: 15 attempts exhausted
    SUCCESS --> [*]
    REQUIRES_ATTENTION --> [*]
```

---

# Приложение B. Target attempt log

Каждая попытка должна давать компактную запись вида:

```json
{
  "client": "alena",
  "date": "2026-10-05",
  "action": "morning",
  "cycle": 2,
  "cycleAttempt": 3,
  "globalAttempt": 8,
  "outcome": "failure",
  "stage": "post-login",
  "reason": "state-unresolved",
  "airtopSessionMs": 27650
}
```

При success:

```json
{
  "client": "alena",
  "date": "2026-10-05",
  "action": "morning",
  "cycle": 2,
  "cycleAttempt": 4,
  "globalAttempt": 9,
  "outcome": "success",
  "status": "clicked",
  "httpStatus": 200,
  "fact": "08:29:41"
}
```

---

# Приложение C. Source of truth

Основной источник документации:

```text
nikmad-ops/bilky_v1
/docs/bilky-v4.1-multi-user-architecture.md
```

Правило проекта:

> Если изменение меняет архитектуру, recovery policy, security, permissions, state ownership или user-visible behavior, соответствующая часть этого документа должна обновляться вместе с кодом.

Markdown является source of truth. Из него при необходимости создаются DOCX и PDF для onboarding, но редактировать вручную отдельные PDF/DOCX версии не следует.
