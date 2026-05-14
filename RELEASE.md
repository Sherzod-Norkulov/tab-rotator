# Release Process

Документ описывает, как подготовить и выпустить новую версию расширения
**Tab Rotator**.

## 1. Pre-flight

Перед началом релиза убедитесь, что:

- Все изменения, попадающие в релиз, смерджены в `main`.
- Рабочее дерево чистое (`git status` без изменений).
- Рабочая ветка обновлена: `git pull --rebase origin main`.
- Все пункты из [`QA_CHECKLIST.md`](QA_CHECKLIST.md) пройдены локально.

## 2. Bump версии

Версия должна быть консистентна в следующих местах:

- `manifest.json` → поле `"version"` — **единственный источник истины** для
  версии рантайма. `background.js` и popup читают её из
  `chrome.runtime.getManifest().version`.
- `CHANGELOG.md` → новая секция `## [X.Y.Z] — YYYY-MM-DD`.
- `README.md` / store-документы → при необходимости обновить видимые пользователю упоминания текущей версии, чтобы они не противоречили `manifest.json`.

Правило: **SemVer**.

- `MAJOR` — ломающие изменения для пользователей (удаление фич, смена схемы
  storage без миграции, изменение permissions).
- `MINOR` — новые возможности, обратно совместимые изменения.
- `PATCH` — только исправления багов и документация.

## 3. CHANGELOG

Обновите `CHANGELOG.md`:

- Добавьте секцию с новой версией и датой.
- Используйте блоки `Added`, `Changed`, `Fixed`, `Removed`, `Security`, `Notes`.
- Кратко, списком, без маркетинга — это источник истины для release notes в
  Chrome Web Store.

## 4. Сборка релизного ZIP

```bash
bash scripts/package.sh
```

Результат: `dist/tab-rotator-<version>.zip`.

Скрипт:

- читает версию из `manifest.json`,
- проверяет наличие обязательных файлов (`manifest.json`, `background.js`,
  `popup.html`, `popup.js`, locales, иконки),
- исключает `.git`, `.github`, `dist`, `scripts`, `*.md`, `.gitignore`, редакторские
  каталоги,
- создаёт архив с runtime-файлами расширения.

Проверьте содержимое архива:

```bash
unzip -l dist/tab-rotator-<version>.zip
```

В ZIP **должны быть**: `manifest.json`, `background.js`, `popup.html`,
`popup.js`, `_locales/`, `assets/icons/`, `assets/screenshots/`, `LICENSE`.

В ZIP **не должно быть**: `.git`, `.github`, `dist`, `scripts`, `*.md`, `.gitignore`.

## 5. Локальная верификация собранного ZIP

1. Распакуйте ZIP во временный каталог: `unzip dist/tab-rotator-<version>.zip -d /tmp/tr-release`.
2. `chrome://extensions/` → удалите dev-версию.
3. «Load unpacked» → выберите `/tmp/tr-release`.
4. Прогоните [`QA_CHECKLIST.md`](QA_CHECKLIST.md) целиком на распакованном ZIP.

Это гарантирует, что именно собранный артефакт работает, а не dev-дерево.

## 6. Git tag и GitHub Release (автоматически)

Начиная с версии 1.2.0 публикация GitHub Release автоматизирована через
GitHub Actions — см. `.github/workflows/release.yml`.

Последовательность при выпуске:

1. На отдельной ветке обновите `"version"` в `manifest.json` и добавьте
   секцию в `CHANGELOG.md`, откройте PR в `main`. Workflow `CI`
   (`.github/workflows/ci.yml`) обязан пройти — валидирует JSON и
   собирает ZIP через `scripts/package.sh`.
2. После merge PR в `main` автоматически запускается
   `.github/workflows/release.yml`:
   - переиспользует CI (валидация JSON + сборка ZIP),
   - читает версию из `manifest.json`,
   - если тега `v<version>` ещё нет — создаёт git-tag и GitHub Release
     с именем `Tab Rotator v<version>` и приложенным
     `dist/tab-rotator-<version>.zip`,
   - описание берёт из секции `## [<version>]` в `CHANGELOG.md`,
   - если тег/релиз уже существует — завершается корректно без
     дубликатов.

> Чтобы выпустить новую версию, достаточно поднять `"version"` в
> `manifest.json`, добавить секцию в `CHANGELOG.md` и смерджить PR в
> `main`. Всё остальное сделает release workflow.

Ручные команды `git tag` / `gh release create` при штатном процессе
**больше не нужны** и оставлены ниже только как аварийный fallback.

<details>
<summary>Ручной fallback (если Actions недоступны)</summary>

```bash
git tag -a v<version> -m "Tab Rotator v<version>"
git push origin v<version>
gh release create v<version> dist/tab-rotator-<version>.zip \
  --title "Tab Rotator v<version>" \
  --notes-file release_notes.md
```

</details>

## 7. Публикация в Chrome Web Store

1. Откройте [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Выберите item «Tab Rotator» → **Package** → **Upload new package**.
3. Загрузите `dist/tab-rotator-<version>.zip`.
4. Обновите:
   - Store Listing (использовать тексты из `STORE_LISTING.md`, при необходимости
     обновить скриншоты в `assets/screenshots/`),
   - Privacy practices (ссылка на `PRIVACY_POLICY.md` в публичном репозитории),
   - Permissions justification (tabs + storage, без host permissions),
   - «What's new» — release notes из `CHANGELOG.md`.
5. Отправьте на review.
6. После approval — дождитесь публикации и проверьте страницу расширения в
   Chrome Web Store.

## 8. Post-release

- Убедитесь, что установленная из Store версия совпадает с `manifest.json`.
- Создайте issues для выявленных багов / backlog.
- Обновите `main` при необходимости (hotfix → patch-версия).

## 9. Откат

Если релиз сломан:

1. В Chrome Web Store откатиться к предыдущему package нельзя напрямую — нужно
   выпустить новую версию (патч), возвращающую прежнее поведение.
2. Быстро: `git revert` проблемных коммитов → bump патч-версии → пройти шаги 3–7
   заново.

## 10. Автоматизация CI/CD (GitHub Actions)

В репозитории настроены два workflow:

- `.github/workflows/ci.yml` — **CI**. Срабатывает на каждый pull request в
  `main` и на push в `main`. Шаги:
  1. Валидация `manifest.json` и всех `_locales/*/messages.json`.
  2. Проверка, что `"version"` имеет формат `X.Y[.Z[.W]]`.
  3. Сборка релизного ZIP через `bash scripts/package.sh`.
  4. Загрузка ZIP как артефакта (`tab-rotator-<version>`).

  Этот workflow также объявлен как **reusable** (`workflow_call`) — его
  переиспользует release workflow, чтобы логика валидации/сборки жила в
  одном месте. Рекомендуется сделать CI required check в branch
  protection для `main`.

- `.github/workflows/release.yml` — **Release**. Срабатывает только на
  push в `main` (то есть после merge PR). Шаги:
  1. Job `ci` — полностью прогоняет `ci.yml` как reusable workflow.
     Если CI падает, релиз не создаётся.
  2. Job `release` (запускается, только если `ci` зелёный):
     - читает версию из `manifest.json`,
     - формирует тег `v<version>` и имя релиза `Tab Rotator v<version>`,
     - проверяет, существует ли уже GitHub Release или git-тег с таким
       именем (через `gh release view` и `git ls-remote`),
     - если существует — завершает работу без ошибки и без дубликата,
     - если не существует — создаёт аннотированный git-тег, извлекает
       секцию `## [<version>]` из `CHANGELOG.md` в качестве release
       notes и создаёт GitHub Release с приложенным
       `dist/tab-rotator-<version>.zip`.

  Дополнительно:
  - `concurrency: release-main` — сериализует релизные прогоны по
    `main`, чтобы исключить гонки при создании тега/релиза.
  - Минимальные `permissions`: у CI — `contents: read`, у job-а
    `release` — `contents: write` (нужно для создания тега и релиза).
  - `gh release create ... --verify-tag` — дополнительная страховка от
    публикации релиза без git-тега.

### Что должен делать разработчик перед merge

1. В релизном PR поднять `"version"` в `manifest.json` по SemVer.
2. Добавить секцию `## [<version>] — YYYY-MM-DD` в `CHANGELOG.md`.
3. Дождаться зелёного CI на PR.
4. Смерджить PR в `main`.

После merge release workflow сам соберёт ZIP, создаст тег и
GitHub Release. Никаких `git tag` / `git push --tags` вручную не нужно.

### Что происходит, если тег уже существует

Если GitHub Release уже существует, workflow корректно и безопасно
завершается без ошибки: пишет в лог сообщение «GitHub Release
`v<version>` уже существует — ничего не делали». Если существует только
git-тег, rerun не создаёт дубликат тега, а публикует недостающий release
для этого тега.

### Рекомендации по branch protection для `main`

- Require a pull request before merging.
- Require status checks to pass → добавить required check `CI /
  Валидация и сборка ZIP`.
- Require branches to be up to date before merging.
- Запретить прямой push в `main`, в том числе админам, если это
  соответствует процессу команды.
