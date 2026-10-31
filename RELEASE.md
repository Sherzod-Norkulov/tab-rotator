# Выпуск Tab Rotator

Источник версии — `manifest.json`; описание изменения — соответствующая секция `CHANGELOG.md`. Перед новой версией проверить согласованность локализаций, обязательных runtime файлов и пройти `QA_CHECKLIST.md`. Source CI не подтверждает работу установленного расширения или публикацию в Chrome Web Store.

## GitHub Actions и собственная ВМ

`release.yml` принимает только owner push в `main` или ручной запуск owner main. Его job `ci` вызывает reusable `ci.yml`; workflow outputs `version`, `artifact-name`, `zip-sha256` поступают из outputs единственного build job. Release зависит от успешного CI и использует только producer outputs своего main run/attempt.

`pr.yml` отдельно вызывает тот же reusable workflow для owner-only PR из этого же public repository в `main`, без forks. Required check называется **CI (обязательные проверки) / Валидация и сборка ZIP**. Actor/triggering actor, sender и автор PR должны быть владельцем; base/head repository IDs и exact merge SHA/оба родителя проверяются до recipes. PR имеет только `contents: read`, без release/OIDC credentials. Его ZIP — disposable проверка: release handoff не записывается, tags/releases не создаются. После merge main source проверяется заново; PR ZIP никогда не принимается release receiver.

Все jobs используют repository-scoped `tab-rotator-vm`, pinned checkout exact SHA без сохранения credentials и отдельные checkout paths по run/attempt/job. Release admission проверяет public owner repository1114674208, caller `release.yml`/workflowSHA, main/ref/payload и source SHA, actor/triggering actor, run/attempt/job/workspace; PR admission принимает только `pr.yml` и exact PR merge/base/head. Build имеет `contents: read`; GH_TOKEN передаётся только явно указанным release steps, не ZIP build/restore. ВМ использует общий ограничитель: одна тяжёлая работа,4ГиБ host reserve,3ГиБ aggregate CI; Docker и установки пакетов расширению не требуются.

ZIP строится из изолированного `git archive HEAD`: committed runtime files и committed `scripts/package.sh`, без modified/untracked/ignored содержимого рабочего дерева. Tracked symlinks запрещены. Проверяются JSON, JavaScript syntax и небольшие unit regressions. Producer сохраняет ZIP и manifest в закрытый фиксированный namespace ВМ с sourceSHA/run/attempt/producer identity и SHA256. GitHub artifact storage не используется. Release receiver проверяет producer outputs, metadata и checksum до разбора ZIP, затем ограничивает размер и распакованный объём. Второй ZIP для release не собирается. SameUID не является границей изоляции; checksum и write-once handoff не объявляются криптографической аттестацией против другого процесса того же UID.

## Существующая версия1.4.0

Опубликованный стабильный GitHub Release `v1.4.0` и его tag/assets сохраняются. Последующий main source commit с прежней версией проверяется CI, но существующий релиз не переназначается и новый ZIP в него не загружается. Если есть только неопубликованный тег, его peeled commit обязан равняться exact source SHA запуска; несовпадение вызывает отказ. Draft/prerelease или release без tag требуют отдельного решения, workflow не исправляет их автоматически.

## Новая версия

1. Обновить `manifest.json` и `CHANGELOG.md`, проверить локализации/runtime и выполнить локальную QA.
2. Создать owner PR из того же репозитория, пройти required check и review, затем merge в protected main. Внешние/fork PR не допускаются на ВМ.
3. Owner main push/manual запускает reusable CI. При отказе публикация не выполняется.
4. Для ещё не опубликованной версии receiver получает ровно проверенный ZIP; существующий unpublished tag проверяется на exact source. Если tag отсутствует, создаётся аннотированный tag через GitHub API, затем GitHub Release с ZIP и notes из CHANGELOG. `--verify-tag` и concurrency release-main сохранены. Force push, retag, перезапись assets и повторная сборка отсутствуют.

Восстановительные ручные операции с tag/release требуют отдельного плана владельца; они не являются обходом отказа admission или provenance. Служебные отчёты — в едином run artifacts, секреты туда не записываются.

## Chrome Web Store и откат

GitHub Release не публикует расширение в Store автоматически. Владелец отдельно загружает проверенный ZIP в Developer Dashboard, обновляет listing/privacy/permissions/notes, проходит review и проверяет установленную Store-версию по QA checklist. Эта внешняя приёмка остаётся отдельной. При дефекте требуется новая patch-версия с исправлением; прежний опубликованный tag/ZIP сохраняется.
