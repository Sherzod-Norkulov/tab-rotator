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
- `README.md` → строка «**Версия:** X.Y.Z» в шапке.

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
- создаёт детерминированный архив.

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

## 6. Git tag и GitHub Release

```bash
git add .
git commit -m "chore(release): v<version>"
git tag -a v<version> -m "Tab Rotator v<version>"
git push origin main
git push origin v<version>
```

На GitHub:

1. Releases → Draft a new release.
2. Tag: `v<version>`.
3. Title: `Tab Rotator v<version>`.
4. Описание: скопируйте соответствующую секцию из `CHANGELOG.md`.
5. Прикрепите `dist/tab-rotator-<version>.zip`.
6. Опубликуйте.

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
