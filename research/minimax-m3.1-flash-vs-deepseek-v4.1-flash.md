# MiniMax-M3.1-Flash vs DeepSeek-V4.1-Flash-1017

Сверка по первичным источникам. Дата среза: **2026-11-05**. Все цифры ниже взяты из
официальных карточек моделей, документации провайдеров и независимого бенчмарка
Artificial Analysis; каждая строка снабжена ссылкой. Где источника нет — стоит
«не подтверждено».

Обозначения: **MM** = MiniMax-M3.1-Flash, **DS** = DeepSeek-V4.1-Flash-1017.

## 1. Идентичность и лицензии

| | MM | DS |
| :- | :- | :- |
| Org / repo | `MiniMaxAI/MiniMax-M3.1-Flash` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| Дата релиза | 2026-10-19 | 2026-10-17 |
| Лицензия | MINIMAX COMMUNITY LICENSE (`license: other`) | MIT |
| Коммерческое использование | Разрешено, но: обязательная атрибуция «Built with MiniMax M3.1-Flash»; при выручке > $20 млн/год нужно предварительное письменное разрешение; иначе — разовое уведомление на api@minimax.io | Без ограничений |
| Запреты сверх лицензии | Приложение Prohibited Uses (военное применение, вред несовершеннолетним, дезинформация и т. п.) | — |

Источники: [карточка MM](https://huggingface.co/MiniMaxAI/MiniMax-M3.1-Flash/raw/main/README.md),
[LICENSE MM](https://huggingface.co/MiniMaxAI/MiniMax-M3.1-Flash/raw/main/LICENSE),
[карточка DS](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/raw/main/README.md).

Популярность на HF (2026-11-05): MM — 548 лайков / 30 211 загрузок; DS — 5 297 лайков /
221 621 загрузка ([HF API MM](https://huggingface.co/api/models/MiniMaxAI/MiniMax-M3.1-Flash),
[HF API DS](https://huggingface.co/api/models/deepseek-ai/DeepSeek-V4.1-Flash-1017)).

## 2. Архитектура

| | MM | DS |
| :- | :- | :- |
| Тип | native multimodal MoE, 60 слоёв, hidden 6144 | multimodal MoE, Causal Encoder-Decoder (CED): 20 слоёв энкодера + 20 декодера, hidden 5120 |
| Всего параметров | ≈428B | 552B backbone + 196B Engram conditional memory |
| Активных на токен | ≈23B | 8B на prefill / 16B на decode |
| Эксперты | 128 локальных, 4 routed + 1 shared на токен | 384 routed + 1 shared, 6 routed на токен |
| Внимание | MiniMax Sparse Attention (MSA) во всех слоях | Compressed Sparse Attention 2 (CSA2), 3 режима слоёв (Full/Reindex/Reuse), иерархический sparse indexer |
| KV-кэш | не опубликован в байтах | 890 байт/токен в HBM; персистентный — ≈1/8 от V4-Flash |
| Квантизация | QAT, MXFP8 dense + NVFP4 эксперты | FP8 (блочная 32×32, dynamic) + FP4 эксперты, FP4 KV |
| Спекулятивное декодирование | DSpark (draft-голова в комплекте) | DSpark (semi-autoregressive draft) |
| Вход / выход | текст, изображение, **видео** → текст | текст, изображение → текст |

Источники: [config MM](https://huggingface.co/MiniMaxAI/MiniMax-M3.1-Flash/raw/main/config.json),
[config DS](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/raw/main/config.json),
[техотчёт DS (PDF)](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/DeepSeek_V41_Tech_Report.pdf),
[карточка MM](https://huggingface.co/MiniMaxAI/MiniMax-M3.1-Flash/raw/main/README.md).

Важно: у DS две разные цифры «активных» параметров — 8B при prefill и 16B при decode
(это следствие CED). Artificial Analysis в сравнениях использует 16B.

## 3. Контекст, лимиты выхода, режимы

| | MM | DS |
| :- | :- | :- |
| Контекст (API) | 1 000 000 | 1M |
| Контекст (веса) | 1 048 576 | 1 048 576 |
| Макс. выход | 524 288 (512K); рекомендация 131 072 (128K) | 393 216 (384K); рекомендация ≥ 256K |
| Отключение thinking | **Нельзя** — `thinking: disabled` или `effort: "none"` даёт HTTP 400 | Можно: `thinking: {"type": "disabled"}` / `reasoning_effort` = `none` |
| Уровни effort | `low`/`medium`/`high`/`xhigh`/`max`, по умолчанию **max** | `none`/`low`/`high`/`max` (+ непрерывный 1–100 в весах), по умолчанию **high** |
| Сэмплирование | `temperature=1.0` (принудительно, параметр игнорируется), `top_p=0.95` | `temperature=1.0`, `top_p=1.0` |
| Лимиты API | 200 RPM / 10 000 000 TPM | 2500 одновременных соединений на аккаунт |

Источники: [MM Model Invocation](https://platform.minimax.io/docs/guides/text-generation.md),
[MM OpenAI API](https://platform.minimax.io/docs/api-reference/text-chat-openai.md),
[MM Rate Limits](https://platform.minimax.io/docs/guides/rate-limits.md),
[DS Pricing](https://api-docs.deepseek.com/quick_start/pricing.md),
[DS Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit.md),
[DS Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode.md).

## 4. Мультимодальность

| | MM | DS |
| :- | :- | :- |
| Изображения | JPEG/PNG/GIF/WEBP; ≤ 10 MB (URL/base64), body ≤ 64 MB | JPEG/PNG/GIF/WEBP; ≤ 32 MiB по URL, ≤ 64 MiB через Files API, body ≤ 48 MiB |
| Видео | Да: MP4/AVI/MOV/MKV, ≤ 50 MB (URL/base64), ≤ 512 MB через Files API | **Нет** |
| Токены на изображение | `low` ≈ до 600; `default` ≈ 1–3k (до ~5k); `high` ≈ до 15k+ | `max_image_tokens` = 1024 в конфиге vision-энкодера |
| Выход | только текст | только текст |

Источники: [MM Anthropic API](https://platform.minimax.io/docs/api-reference/text-anthropic-api.md),
[DS Vision](https://api-docs.deepseek.com/guides/vision.md),
[config DS](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/raw/main/config.json).

## 5. Цены (официальные API, $ за 1M токенов)

| | MM | DS off-peak | DS peak |
| :- | :- | :- | :- |
| Вход, cache miss | 0.15 | 0.15 | 0.30 |
| Вход, cache hit | 0.015 | 0.003 | 0.006 |
| Выход | 0.60 | 0.60 | 1.20 |

DS: peak — 01:00–04:00 и 06:00–10:00 UTC по будням (кроме праздников КНР), всё остальное
время off-peak. MM: единый тариф без пиковых надбавок; есть Priority tier (×1.5), но он
описан только для MiniMax-M3, не для M3.1-Flash.

Смешанная цена (AA, blended 3:1 input:output): MM ≈ $0.2625/1M, DS ≈ $0.525/1M.
Средняя стоимость одного задания Intelligence Index: MM **$0.49**, DS **$0.60**
(в основном за счёт большего объёма reasoning-токенов у DS).

Источники: [MM Pricing](https://platform.minimax.io/docs/pricing/overview.md),
[DS Pricing](https://api-docs.deepseek.com/quick_start/pricing.md),
[AA MM](https://artificialanalysis.ai/models/minimax-m3-1-flash),
[AA DS](https://artificialanalysis.ai/models/deepseek-v4-1-flash-1017).

## 6. Бенчмарки, опубликованные вендорами

Значения из карточки MM (там же приведены DS-V4.1-Flash-1017 и DS-V4.1-Flash) —
**единый прогон**, поэтому сравнимы между собой:

| Бенчмарк | MM | DS-1017 | DS-V4.1 |
| :- | :-: | :-: | :-: |
| Automation-Bench v1.0.6 | **62.8** | 60.5 | 54.8 |
| BankerToolBench | **76.2** | — | 73.7 |
| GDP.pdf AA | **20.8** | — | 12.8 |
| Terminal Bench 4.0 | 38.1 | **42.3** | 31.2 |
| LOCA-Bench 256K | **60.3** | — | — |
| Agents' Last Exam | **29.6** | — | — |
| OSWorld 2.0 | **61.7** | — | 54.3 |
| PostTrain Bench v1.1 | **39.3** | — | 30.5 |
| DeepSWE v1.1 | 73.7 | **77.0** | 74.2 |
| NL2Repo-Bench | 61.2 | **68.2** | 65.4 |
| SWE Refactor Bench | **23.0** | — | 11.8 |
| CyberGym | **82.2** | — | — |
| BabyVision (w/ tools) | 91.0 | **92.5** | 89.6 |
| HLE (без инструментов) | **43.4** | 42.6 | 39.2 |
| CharXiv RQ | **82.5** | — | 69.0 |

Прочерк = «нет официального результата», а не ноль (оговорено в карточке MM).

Отдельно из карточки DS: ProgramBench 29.1, Apex Bench v1.1 72.1, Chartography 83.0,
ZeroBench-main 51.0. Codeforces-рейтинг 3471, MathArena Apex 65.6, GPQA Diamond 90.9,
Terminal-Bench 2.1 90.6 (для сравнения: Opus-5.0 — 89.1).

Осторожно с харнессами: MM гоняет Terminal Bench 4.0 на Codex 0.149.1, DS — на Claude Code;
DeepSWE обе стороны — на mini-SWE-agent, но у MM 2.4.5 и 512K контекста, у DS свой Minimal
режим с 1M. Поэтому строки Terminal Bench и DeepSWE сравнимы лишь приблизительно.

Источники: [карточка MM](https://huggingface.co/MiniMaxAI/MiniMax-M3.1-Flash/raw/main/README.md),
[карточка DS-1017](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/raw/main/README.md),
[карточка DS-V4.1](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/raw/main/README.md).

## 7. Независимые данные Artificial Analysis (Intelligence Index v5.0.1)

Оба провайдера помечены как first-party (MiniMax и DeepSeek соответственно), то есть
цены и скорость измерены на официальных эндпоинтах.

| Метрика | MM | DS |
| :- | :-: | :-: |
| Intelligence Index | 29 | **33** (#1 среди open weights) |
| Место среди open weights | #5 / 24 | **#1 / 24** |
| AA-Briefcase (Elo) | 1475.98 | **1570.42** |
| AutomationBench-AA | **0.725** | 0.666 |
| Terminal-Bench 4.0 | 0.258 | **0.338** |
| FrontierCode 2.0 | 0.208 | **0.285** |
| AA-Omniscience | −6.4 | **0.9** |
| GDP.pdf | **0.208** | 0.172 |
| HLE-Diamond | **0.281** | 0.253 |
| CritPt v2 (hard) | **0.325** | 0.250 |
| Terminal-Bench-Science | 0.033 | **0.129** |
| Скорость вывода | 117 tok/s | **175 tok/s** |
| TTFT | 1.77 s | **1.38 s** |
| Время до первого токена ответа | 66.26 s | **50.78 s** |
| Время на задание | 19.6 мин | **13.3 мин** |
| Стоимость задания | **$0.49** | $0.60 |
| Openness Index | 27.8 | **44.4** |

Источники: [AA MM](https://artificialanalysis.ai/models/minimax-m3-1-flash),
[AA DS](https://artificialanalysis.ai/models/deepseek-v4-1-flash-1017).

## 8. Скорость: официальные заявления против измерений

- MiniMax в анонсе: «200+ TPS в повседневном использовании, медиана P50 — 170+ TPS», плюс
  «инференс почти втрое быстрее, стоимость ниже на 70%» относительно M3
  ([блог](https://www.minimax.io/blog/minimax-m31f)). AA на своём стенде получил 117 tok/s —
  ниже, потому что меряет на длинных reasoning-трассах с effort=max.
- DS собственных цифр TPS не публикует; AA измерил 175 tok/s и более быстрое время на задание.
- Самохостинг, SGLang на 4×B300 (TP4, acceptance length 5): decode **1028 tok/s** при 1K
  контекста, **919** при 256K, **723** при 1M. Альтернативный путь без MonoKernel: 479/465/408
  ([SGLang cookbook](https://docs.sglang.io/cookbook/autoregressive/MiniMax/MiniMax-M3.1.md)).
- SGLang на MI355X, 64 сессии: 90 168 tok/s на GPU, P90 TTFT 1.21 s (там же).
- Для DS официальных цифр пропускной способности самохостинга не опубликовано — только
  архитектурные аргументы (8B активных на prefill, 890 байт KV на токен).

## 9. Самохостинг

**MM.** Официально рекомендуются SGLang, vLLM и TokenSpeed
([карточка](https://huggingface.co/MiniMaxAI/MiniMax-M3.1-Flash/raw/main/README.md)).
Мультичиповость — через FlagOS: W8A8-версии для девяти платформ (T-Head, NVIDIA, MetaX,
Hygon, Huawei Ascend, Moore Threads, Iluvatar, Kunlunxin, Tsingmicro)
([FlagOS doc](https://huggingface.co/MiniMaxAI/MiniMax-M3.1-Flash/blob/main/docs/FlagOS-Multi-Chip-Support-and-Downloads.md)).
По официальной документации самохостинга M3 (ближайший аналог): 8×B200 TP8 — эталон,
вес репозитория ≈444 GB в MXFP8 (≈854 GB в BF16 для H200 TP8), статус — **экспериментальный**,
SLA не гарантируется; минимальные требования к host-memory и пиковому потреблению GPU
не публикуются ([local-deploy-m3](https://platform.minimax.io/docs/guides/local-deploy-m3.md)).

**DS.** Reference-реализация в репозитории (`inference/`), конвертация в TP8 через
`convert.py --expert-dtype fp4`, запуск через `torchrun`. Это «читаемая референсная
реализация, а не продакшн-движок»; для продакшна предлагается `deepseek-recipe`
([inference README](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/raw/main/inference/README.md)).
Общий размер весов на HF — ≈763B параметров в safetensors (≈511 GB хранилища) в FP8/FP4/INT8
([HF API](https://huggingface.co/api/models/deepseek-ai/DeepSeek-V4.1-Flash-1017)).
Официальных требований к числу GPU не опубликовано.

## 10. Инструменты и API-совместимость

| | MM | DS |
| :- | :- | :- |
| OpenAI Chat Completions | Да | Да |
| Anthropic Messages | Да (рекомендуемый путь) | Да |
| OpenAI Responses API | Да | Да |
| Tool calling | Да, с interleaved thinking | Да |
| Structured output / JSON | Через схему в tools; отдельный `response_format` в OpenAPI-спеке не заявлен | JSON Output + tool calls, structured outputs |
| Prompt caching | Да, read $0.015/1M | Да, автоматический, hit $0.003–0.006/1M |
| FIM / prefix completion | не подтверждено | Да (beta, только non-thinking) |
| Self-hosted лицензия на форк | Community license, атрибуция обязательна | MIT |

Источники: [MM OpenAI API](https://platform.minimax.io/docs/api-reference/text-chat-openai.md),
[MM Tool Use](https://platform.minimax.io/docs/guides/text-m3-function-call.md),
[DS Pricing (features)](https://api-docs.deepseek.com/quick_start/pricing.md).

## 11. Что осталось неподтверждённым

- Точные требования к железу для DS при самохостинге (число GPU, VRAM, driver) — вендор
  их не публикует.
- Минимальный/рекомендуемый объём host-memory и пиковое потребление GPU для MM — в
  официальном гайде прямо сказано «not published».
- Байтовый размер KV-кэша MM (у DS — 890 байт/токен, у MM аналога нет).
- Гарантированная поддержка `response_format`/`json_schema` в OpenAI-совместимом API MM:
  в OpenAPI-спеке поле не описано, структурный вывод доступен только через схемы в `tools`.
- Прямое сравнение Terminal-Bench 4.0 и DeepSWE между вендорами затруднено разными
  харнессами и длиной контекста.

## Вывод в одну строку

По независимым замерам DS-1017 — сильнее (33 против 29 Intelligence Index), быстрее
(175 против 117 tok/s, 13.3 против 19.6 мин на задание) и с более свободной лицензией;
MM выигрывает там, где важны видео на входе, максимальная длина ответа (512K против 384K),
стабильная цена без пиковых надбавок и чуть более низкая стоимость задания ($0.49 против $0.60),
а также отдельные прикладные сценарии — автоматизация офисных процессов, финансы,
кибербезопасность и длинный контекст 256K.
