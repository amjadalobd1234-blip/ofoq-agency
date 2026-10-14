# أفق — مولّد إعلان محلي

Pipeline مستقل داخل هذا المجلد، يعمل من Terminal:

**قوالب نصية → Piper TTS → SadTalker → موسيقى مولّدة بالكود → Remotion / MP4**

لا Groq أو OpenAI أو HeyGen أو edge-tts، ولا مفاتيح API أو خدمة توليد سحابية. الوصف والصورة والصوت والتصيير تبقى على جهازك. يلزم الإنترنت **للتثبيت وتنزيل النماذج والصورة التجريبية مرة واحدة فقط**؛ لا تنزيل تلقائي أثناء التوليد. لا يتصل الكود بالموقع ولا يُنشر على Cloudflare.

> **تنبيه ترخيص مهم:** محلي لا يعني أن جميع المكوّنات ملك حصري لأفق أو مفتوحة المصدر بترخيص غير مشروط. Remotion 4 يستخدم ترخيصًا خاصًا: الاستخدام مجاني للأفراد وللشركات الربحية حتى 3 موظفين ولجهات أخرى محددة؛ قد يلزم ترخيص شركة فيما عدا ذلك. لذلك لا نعد بأن هذه البنية «مجانية 100% لكل شركة» أو «بلا اعتماد على أي شركة». Piper 1.3 هو GPL-3.0، وأصواته والنماذج والصور لها حقوق منفصلة. راجع [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) قبل الاستعمال التجاري أو التوزيع. إذا كان شرط الترخيص الحر غير المشروط حاسمًا، يلزم استبدال Remotion بمركّب آخر؛ لم نستبدله هنا لأنه جزء من البنية المطلوبة.

## 🚀 التشغيل السريع (Google Colab)

1. افتح [Google Colab](https://colab.research.google.com)
2. File → Open notebook → GitHub
3. الصق: `amjadalobd1234-blip/ofoq-agency`
4. اختر: `tools/video-agent/video_agent.ipynb`
5. Runtime → Change runtime type → **T4 GPU**
6. شغّل كل الخلايا (Runtime → Run all)
7. عدّل الوصف في الخلية 9
8. شغّل الخلية 10

**الوقت المستهدف:** 5–8 دقائق للفيديو؛ تقدير غير مُتحقَّق على Colab، ولا يشمل بالضرورة التثبيت وتنزيل النماذج. توافر GPU المجاني وحدود الجلسة تخضع لخدمة Colab.

الـ[Notebook](video_agent.ipynb) مستقل عن كود الأداة ويحتوي على عشر خلايا. تُحفظ الملفات داخل جلسة Colab؛ يمكن تنزيلها من لوحة Files داخل `tools/video-agent/output/`. نزّل النتائج قبل انتهاء الجلسة، ثم أعد تشغيل الخلايا عند بدء جلسة جديدة. التشغيل هنا على خوادم Colab، وليس على جهازك المحلي.

ترتيب الخلايا وفصل الأنواع مهم:

| الخلية (1-based) | النوع | المحتوى |
| --- | --- | --- |
| 2 | shell | فحص GPU وffmpeg وPython وNode |
| 3 | Python | استنساخ/تحديث المستودع |
| 4 | shell | `apt-get install -y -qq gfortran ffmpeg chromium-browser` |
| 5 | shell | `npm install` وpip ونماذج Piper |
| 6 | shell (`%%bash`) | تنزيل الصورة الافتراضية من Unsplash إن فُقدت أو كانت فارغة، دون استبدال صورتك؛ فشل التنزيل يوقف الخلية |
| 7 | Colab (SadTalker) | استنساخ SadTalker إلى `/content/SadTalker`، تحميل النماذج (~2 GB)، وإنشاء `.venv-sadtalker` |
| 8 | Python | كشف المتصفح وضبط `BROWSER_EXECUTABLE` و`PUPPETEER_EXECUTABLE_PATH` |
| 9 | Python | وصف الإعلان والقالب |
| 10 | Python | ضبط `SADTALKER_DIR` و`AVATAR_MODE` وتشغيل `npm start` وعرض الفيديو |

الخلية 8 تضبط متغيرات المتصفح قبل الوصول إلى الخلية 10، والأداة تكشف المتصفح تلقائيًا إن لم تُضبط.

## SadTalker Setup الكامل

> **⚠️ تحذير:** يحتاج SadTalker إلى **~4 GB RAM** على الأقل أثناء التثبيت والتشغيل، وحجم النماذج **~2 GB**.
>
> - **وقت التثبيت:** 15-25 دقيقة في Google Colab.
> - **احتمال الفشل في Colab المجاني:** قد يفشل التثبيت أو الاستدلال في Colab المجاني بسبب نفاد الذاكرة (RAM).
> - **الوضع الاحتياطي (Fallback):** في حال فشل SadTalker (بسبب الذاكرة أو عدم اكتمال التثبيت)، تتحوّل الأداة تلقائيًا إلى الوضع `AVATAR_MODE=auto` لتوليد فيديو الشخص من الصورة الثابتة دون توقف الـPipeline بالكامل.

خطوات التثبيت الكامل في Colab (الخلية 7):

```python
# تثبيت SadTalker
import os

SADTALKER_DIR = "/content/SadTalker"

# استنساخ SadTalker
if not os.path.exists(SADTALKER_DIR):
    !git clone https://github.com/OpenTalker/SadTalker.git {SADTALKER_DIR}

# تثبيت المكتبات
!cd {SADTALKER_DIR} && pip install -q -r requirements.txt

# تثبيت gdown للتحميل
!pip install -q gdown

# تحميل النماذج (2 GB)
!cd {SADTALKER_DIR} && bash scripts/download_models.sh

# إنشاء venv للعزل
!python -m venv {SADTALKER_DIR}/.venv-sadtalker
!{SADTALKER_DIR}/.venv-sadtalker/bin/pip install -q -r {SADTALKER_DIR}/requirements.txt

print("✅ SadTalker جاهز")
```

وفي خلية التشغيل (الخلية 10) تُضبط المتغيرات:

```python
os.environ["SADTALKER_DIR"] = SADTALKER_DIR
os.environ["AVATAR_MODE"] = "sadtalker"
```

تتحقق `src/avatar.ts` من وجود `${SADTALKER_DIR}/.venv-sadtalker/bin/python` قبل التشغيل:
- إذا كان `AVATAR_MODE=sadtalker` والبيئة غير موجودة، تعرض رسالة خطأ واضحة تتضمن خطوات التثبيت الكاملة.
- إذا فشل تشغيل SadTalker أثناء التوليد (أو كان `AVATAR_MODE=auto`)، يتم التراجع تلقائيًا (fallback) إلى الوضع `auto`.

> **حالة التوافق:** الخلايا توثّق وصفة Colab المطلوبة، لكنها ليست مسارًا مكتملًا لتوليد فيديو بضغطة واحدة مع الإصدار الحالي. لم يُجرَ اختبار GPU أو توليد فيديو فعلي على Colab. قبل الاعتماد عليها، يلزم معالجة الآتي:
>
> - يلزم إعداد SadTalker ونماذجه في بيئة Python 3.10 منفصلة وفق قسم التثبيت أدناه؛ تثبيت Torch في بيئة Colab وحدها لا يكفي. الافتراضي `AVATAR_DEVICE=cpu`؛ اختيار T4 في Colab لا يفعّل CUDA داخل الأداة تلقائيًا.
> - يلزم استبدال الصورة التجريبية بصورة تملك حق استخدامها وموافقة صاحبها قبل نشر إعلان، بالإضافة إلى متصفح Chrome/Chromium وخط عربي وفق المتطلبات أدناه. الخلية 4 تثبّت `chromium-browser`، والخلية 7 تضبط مساره إن وُجد.
>
> الخلية 9 تمرّر قيم الخلية 8 عبر arguments في وضع غير تفاعلي، وتتوقف عند فشل الأمر، وتعرض الفيديو النهائي الجديد فقط من المجلد الفرعي للتشغيل. تنزيل Piper في الخلية 5 يستخدم المسار الافتراضي `models/piper`؛ وتنزيل الصورة في الخلية 6 يجري أثناء الإعداد فقط. تراخيص المكوّنات والنماذج والصورة تظل سارية على Colab.

## 1. المتطلبات

- Node.js **18+** وnpm؛ يُفضّل Node.js 22 LTS أو أحدث مدعوم.
- Python **3.10–3.12** لبيئة Piper والموسيقى؛ **Python 3.10 منفصل** لـSadTalker بسبب اعتمادياته القديمة. ليست جميع إصدارات Python المستقبلية متوافقة مع هذه الإصدارات المثبّتة.
- FFmpeg وFFprobe مثبتان محليًا ومتاحان في PATH.
- Chrome/Chromium **مثبت محليًا على النظام**. تُكتشف الأداة تلقائيًا بالترتيب: `PUPPETEER_EXECUTABLE_PATH` ثم `BROWSER_EXECUTABLE` ثم المسارات المعروفة (`/usr/bin/chromium-browser` و`/usr/bin/chromium` و`/usr/bin/google-chrome` و`/usr/bin/google-chrome-stable`). عدم العثور على متصفح يوقف العملية برسالة واضحة، ولا يبدأ تنزيلًا تلقائيًا. راجع [قسم المتصفح](#المتصفح-chromiumchrome) و[استكشاف الأخطاء](#8-استكشاف-الأخطاء).
- مساحة كافية للنماذج وبيئتي Python (عدة GB). CPU مدعوم لكنه قد يكون بطيئًا جدًا. NVIDIA GPU/CUDA اختياري ويتطلب نسخة PyTorch متوافقة.
- صورة أمامية واضحة لشخص واحد، بترخيص وموافقة على الإعلان المتحرك **قبل النشر**؛ تُنزّل صورة تجريبية تلقائيًا أثناء الإعداد فقط.
- خط نظام يدعم العربية، مثل Noto Sans Arabic، أو ملف WOFF2 مرخّص محلي.

السكربتات موجّهة إلى Linux/macOS؛ على Windows استخدم WSL2. SadTalker وPyTorch القديم قد يحتاجان تعديلات خاصة بمعمارية جهازك؛ الإعداد الافتراضي يستهدف Linux x86_64 / Python 3.10.

## 2. التثبيت (مع الإنترنت)

من جذر المستودع:

```sh
cd tools/video-agent
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt
bash python/setup_models.sh
cp .env.example .env
```

يجب توفير `python3.10` و`ffmpeg` و`ffprobe` قبل تشغيل `setup_models.sh`. إذا كان اسم Python 3.10 مختلفًا:

```sh
SADTALKER_SETUP_PYTHON=/path/to/python3.10 bash python/setup_models.sh
```

سكربت الإعداد:

1. ينزّل صورة تجريبية 512×512 بصيغة PNG من Unsplash إلى `assets/avatars/man-1.png` **فقط عند فقدها أو فراغها**؛ يحفظها ذريًا ولا يستبدل صورتك غير الفارغة.
2. ينزّل `ar_JO-kareem-medium.onnx` وملف إعداداته و`MODEL_CARD` إلى `models/piper/` من مستودع أصوات Piper.
3. يجلب مصدر SadTalker عند revision ثابت إلى `vendor/SadTalker/`.
4. ينشئ `.venv-sadtalker/` مستقلة ويثبّت Torch/Torchvision واعتماديات SadTalker المتوافقة. لا تخلطها مع بيئة Piper.
5. ينزّل نموذج 256 وmapping ونموذجي كشف الوجه والمحاذاة اللازمين. لا يستخدم محسّن وجه يقوم بتنزيل إضافات عند التشغيل.
6. يسجّل SHA256 للملفات المثبّتة في `models/installed-sha256.json` للمراجعة المحلية. هذا سجل للتنزيل الفعلي، **ليس تحققًا من توقيعات الناشر**.

مصادر التثبيت تشمل Unsplash وnpm وPyPI وGitHub وHugging Face ومستودع حزم PyTorch. التشغيل بعد اكتمال التثبيت لا يحتاجها. أصوات Piper إعدادات مدعومة بالتثبيت، وليست أوزانًا مضمّنة داخل Git. لا يتم استدعاء سكربت التنزيل من `npm start`.

لـCUDA، اختر مستودع حزم يناسب تعريفات جهازك، ثم غيّر `AVATAR_DEVICE=cuda`:

```sh
PYTORCH_INDEX_URL=https://download.pytorch.org/whl/cu118 bash python/setup_models.sh
```

لا يختار السكربت إصدار CUDA المناسب نيابة عنك. حدّث/أعد إنشاء البيئة المنفصلة إذا بدّلت بناء PyTorch بعد تثبيته.

## 3. الصورة والخط والإعداد

تنزّل خلية Colab **6** و`bash python/setup_models.sh` صورة تجريبية من [Unsplash](https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=512&h=512&fit=crop&fm=png) إلى `assets/avatars/man-1.png` إذا كانت مفقودة أو فارغة؛ لا تستبدل ملفًا غير فارغ. معامل `fm=png` ضروري ليكون المحتوى PNG حقيقيًا وليس JPEG باسم `.png`. التنزيل أثناء الإعداد فقط، وليس عند `npm start`، ولا تُحفظ الصورة في Git.

**لاستخدام صورتك بدل الافتراضية:** انسخ صورة تملك حق استخدامها إلى المسار نفسه قبل الإعداد أو بعده (لن يستبدل الإعداد ملفك غير الفارغ)، أو اضبط `DEFAULT_AVATAR` في `.env` لمسار PNG/JPG آخر:

```sh
cp /path/to/approved-portrait.png assets/avatars/man-1.png
# أو في .env: DEFAULT_AVATAR=assets/avatars/my-portrait.jpg
```

أفضل صورة لـSadTalker: **512×512 بكسل**، وجه واحد واضح متجه للأمام، بإضاءة جيدة وخلفية بسيطة، دون حجب العينين أو الفم. الصورة التجريبية للتجربة التقنية فقط: ترخيص [Unsplash](https://unsplash.com/license) **ليس CC0**، ولا يثبت موافقة الشخص الظاهر على تحريك صورته في إعلان. قبل النشر استخدم صورة مع حقوق الاستعمال وموافقة صاحب الوجه الصريحة؛ راجع [ملاحظات التراخيص](THIRD_PARTY_NOTICES.md). `assets/logo.svg` علامة أفق رسومية بسيطة قابلة للاستبدال بشعار الوكالة المعتمد.

أهم متغيرات `.env`:

| المتغير | الافتراضي / الغرض |
| --- | --- |
| `TTS_ENGINE` | `piper` فقط |
| `TTS_VOICE` | `ar_JO-kareem-medium` |
| `TTS_RATE` | `1.0`؛ بين 0.5 و2، وقد تُسرّع المقاطع لتناسب المشهد |
| `TTS_MODEL_DIR` | `models/piper` |
| `AVATAR_ENGINE` | `sadtalker` فقط |
| `AVATAR_MODE` | `sadtalker` (الافتراضي) أو `auto` (للتحويل التلقائي عند غياب/فشل SadTalker) |
| `DEFAULT_AVATAR` | `assets/avatars/man-1.png` |
| `SADTALKER_DIR` | `/content/SadTalker` في Colab أو `vendor/SadTalker` محليًا |
| `SADTALKER_PYTHON` | `.venv-sadtalker/bin/python` (يُفحص داخل `SADTALKER_DIR` أولًا ثم مجلد الأداة) |
| `AVATAR_DEVICE` | `cpu` أو `cuda` |
| `PYTHON_BIN` | `python3` من البيئة المفعّلة، أو `.venv/bin/python` |
| `BROWSER_EXECUTABLE` | مسار Chrome/Chromium الموجود فعليًا على جهازك؛ **اختياري** — تُكتشف المسارات المعروفة تلقائيًا عند تركه فارغًا |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe`، أو مساراتهما المطلقة |
| `OUTPUT_DIR` | `output/` |
| `FPS` | `30` (24–60) |
| `WIDTH` / `HEIGHT` | `1080` / `1080`، أعداد زوجية 320–2160 |
| `TEMPLATE_LANG` | `ar` أو `en` |
| `FONT_FILE` | اختياري: `assets/fonts/font.woff2` |

المسارات النسبية تُحسب من مجلد الأداة، لا من مجلد Terminal. عدّل `BROWSER_EXECUTABLE` قبل التشغيل إن كان متصفحك في مسار غير مألوف؛ `/usr/bin/chromium` مجرد مثال لنظام Linux. على macOS قد يكون `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

### المتصفح (Chromium/Chrome)

Remotion يصيير الإعلان داخل Chrome/Chromium. الأداة لا تنزّل متصفحًا أبدًا: إما أن تجد واحدًا مثبتًا، أو تتوقف برسالة توضّح كيفية تثبيته.

ترتيب الكشف (أول مسار موجود يُستخدم):

1. `PUPPETEER_EXECUTABLE_PATH`
2. `BROWSER_EXECUTABLE`
3. `/usr/bin/chromium-browser`
4. `/usr/bin/chromium`
5. `/usr/bin/google-chrome`
6. `/usr/bin/google-chrome-stable`

إذا ضُبط متغير من المتغيرين الأولين على مسار غير موجود، تتوقف العملية فورًا برسالة تذكر المتغير والمسار والمتصفحات المكتشفة على الجهاز — ولا تنتقل بصمت إلى مسار آخر. وإذا لم يُضبط أي متغير ولم يُعثر على متصفح، تسرد الرسالة كل المسارات التي جرى فحصها.

```sh
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y chromium-browser
# Google Colab
!apt-get install -y -qq chromium-browser
# macOS
brew install --cask google-chrome

# أو حدّد المسار يدويًا
BROWSER_EXECUTABLE=/usr/bin/chromium npm start
```

تحقّق سريع من المتصفح وffmpeg دون تشغيل Pipeline كامل:

```sh
npm run doctor
```

يستخدم `doctor` حزمة `puppeteer-core` لقيادة Chromium المثبّت على النظام فقط (لا تنزيل)، ويطبع مسار المتصفح وإصداره بعد التحقق من `ffmpeg` و`ffprobe`.

للإنجليزية، نزّل صوتها مرة واحدة ثم اضبط `TEMPLATE_LANG=en` و`TTS_VOICE` المطابق:

```sh
TTS_VOICE=en_US-lessac-medium bash python/setup_models.sh
```

سكربت Bash يقرأ المتغيرات المصدّرة من Terminal، **لا ينفّذ محتوى `.env`**. الأمر `npm start` يقرأ `.env` داخل مجلد الأداة.

## 4. التشغيل (محلي بعد التثبيت)

```sh
source .venv/bin/activate
npm start
```

```text
اكتب وصف الإعلان: فيديو لعطر ذهبي فاخر
اختر القالب: [1] عطور [2] مطاعم [3] ملابس [4] خدمات: 1
⏳ كتابة السيناريو...
✅ hook: "عطرك يحكي عنك قبل ما تتكلم"
⏳ توليد الصوت...
✅ voice.wav
⏳ توليد فيديو الشخص...
✅ avatar.mp4
⏳ توليد الموسيقى...
✅ music.wav
⏳ تركيب الفيديو...
✅ الفيديو جاهز: output/<timestamp>-<unique>/ad-<timestamp>-<unique>.mp4
```

لكل تشغيل مجلد فريد لمنع الكتابة فوق إعلان سابق. يحتوي `script.json` و`config.json` و`voice.wav` و`avatar.mp4` و`music.wav` والإعلان النهائي. يمكنك مراجعة النص أو تعديل القوالب وتشغيل الأداة مجددًا. الملفات الوسيطة تبقى للتشخيص، ومجلدات التجميع المؤقتة تُحذف بعد التصيير. `output/` والنماذج والبيئات مستثناة من Git.

### التشغيل دون إدخال تفاعلي (Colab / سكربتات)

```sh
npm start -- --description "فيديو عطر ذهبي، 15 ثانية" \
  --template perfume \
  --productName "عطر الذهب" \
  --benefit "يدوم 24 ساعة" \
  --price "50,000 دينار" \
  --non-interactive
```

- الفاصل `--` بعد `npm start` ضروري حتى تصل الخيارات إلى CLI، وليس إلى npm.
- `--description` (أو `-d`) مطلوب مع `--non-interactive`، بحد أقصى 500 حرف؛ لا يُفتح أي prompt في هذا الوضع، حتى عند الخطأ.
- `--template` (أو `-t`) يقبل `perfume` (الافتراضي) أو `restaurant` أو `clothing` أو `services`.
- `--productName` و`--benefit` و`--price` اختيارية وتصل إلى مولّد السيناريو؛ لا يُختلق سعر عند عدم توفيره. ظهور التفاصيل يتبع القالب والمدة (القوالب القصيرة قد تختصرها).
- `--nonInteractive` اسم بديل مدعوم لـ`--non-interactive`.
- بدون علم الوضع غير التفاعلي يبقى سلوك `npm start` السابق: السؤال عن الوصف ثم رقم القالب.
- الوصف الفارغ/القالب غير الصحيح/الخيار المجهول أو نقص متطلبات التشغيل يؤدي إلى خروج غير صفري، لا إلى انتظار إدخال أو نجاح وهمي. هذا الوضع لا يتجاوز التحقق من النماذج والصورة والمتصفح.

### أمثلة

- `فيديو لعطر ذهبي` → 15 ثانية افتراضيًا.
- `إعلان مطعم، 30 ثانية` → 30 ثانية.
- `إعلان لعطر "ذهب"، ٣٠ ثانية` → يأخذ الاسم المقتبس ومدة 30 ثانية.
- `فيديو لملابس، 5 ثواني` → قالب مختصر لملاءمة المشاهد القصيرة.
- `فيديو لخدمات، 90 ثانية` → 60 ثانية (الحد الأقصى).
- `عطر 100 مل بسعر 30 دولار` → 15 ثانية؛ أرقام السعر/الحجم ليست مدة.

المدة محلية وحتمية: افتراضي 15، حد أدنى 5، أقصى 60، وتقريب لأقرب ثانية. تُدعَم الأرقام الغربية والعربية والفارسية مع وحدات الثواني/الدقائق وبعض الصيغ اللفظية الشائعة. محلّل الوصف بسيط وليس نموذجًا يفهم أي صياغة؛ استخدم `30 ثانية` مثلًا للنتائج المتوقّعة.

## 5. تصميم المراحل

### السيناريو

`templates/script-ar.json` و`script-en.json` يحتويان hooks وbodyTemplates وctas لكل فئة. الاختيار حتمي وقابل للتعديل، مع قوالب قصيرة للمدد ≤8 ثوانٍ. لا نختلق أسعارًا أو ادعاءات منتج من خدمة AI. `generateScript` يدعم `productName` و`benefit` و`price` و`variant` برمجيًا؛ قالب السعر لا يُستخدم دون قيمة صريحة.

### الصوت والتزامن

Piper يعمل على CPU محليًا. يُولَّد hook وbody وCTA كلٌّ على حدة، ثم تُضبط المدد بـFFmpeg لتتوافق مع حدود المشاهد نفسها:

- **0–15%:** hook مع الشعار.
- **15–75%:** body مع الشخص.
- **75–95%:** CTA.
- **95–100%:** وقفة واختفاء نهائي.

المقاطع القصيرة تُملأ بصمت، والطويلة تُسرّع مع الحفاظ على طبقة الصوت. إذا احتاج النص أكثر من ×3 تسريعًا تتوقف العملية وتطلب اختصاره أو زيادة المدة، بدل قصّ الكلمات. الجودة النهائية تتأثر باللغة والنص والصورة والصوت المحلي؛ لا ضمان لجودة استوديو من كل مدخل.

### الشخص

`avatar_generate.py` يستدعي `inference.py` المحلي دون shell، مع نموذج 256 وcrop وبدون face enhancer. يعمل على CPU أو CUDA. يتحقق من الملفات قبل الاستدلال، ويمنع اتصالات Python الشبكية أثناء الاستدلال؛ هذا احتياط برمجي وليس عزلًا أمنيًا على مستوى النظام. للتدقيق الصارم شغّل البيئة المثبّتة مع جدار ناري يحظر الإنترنت. لا بديل سحابي عند الخطأ.

### الموسيقى

`music_generate.py` يولّد أصلًا صوتيًا حتميًا من موجات جيبية وهارمونيكس بتتابع C major → A minor → F → G باستخدام NumPy/SciPy. ينتج PCM16 WAV stereo مع fade in/out وهامش ضد clipping. لا عينات صوتية خارجية ولا API.

```sh
python python/music_generate.py --duration 15 --output output/music.wav
```

### التركيب

فيديو H.264 MP4، 1080×1080 افتراضيًا عند 30fps. خلفية gradient، شعار SVG، نص عربي RTL، انتقالات ظهور/اختفاء، ثم CTA. أصول Remotion تُنسخ إلى مجلد `public` مؤقت ويُشار إليها عبر `staticFile` محلي؛ لا URLs خارجية. فيديو الشخص يستخدم إزاحة البداية المطابقة للصوت ويكون **muted**؛ يوجد مسار تعليق واحد فقط، والموسيقى منخفضة خلفه. يفحص FFprobe مدة الملفات قبل التصيير.

## 6. الاختبارات والتحقق

```sh
npm run build
npm test
python -m pip install -r python/requirements-test.txt
python -m unittest discover -s tests/python -v
bash -n python/setup_models.sh python/download_avatar.sh
```

- `build`: فحص TypeScript دون إصدار ملفات؛ التشغيل عبر `tsx`.
- اختبارات CLI: تحليل arguments، عدم فتح readline في الوضع غير التفاعلي، وصول معلومات المنتج إلى السيناريو، والحفاظ على الوضع التفاعلي. اختبارات subprocess تشغّل `npm start -- ...` فعلًا مع مهلة زمنية وتتحقق من الخروج غير الصفري عند نقص الوصف أو خطأ القالب أو غياب النماذج؛ لا تولّد فيديو حقيقيًا.
- اختبارات Node داخل `tests/`: الحزم، القوالب، المدد، إعدادات البيئة، command builders، pipeline مع mocks، Remotion وتجهيز الأصول والتنظيف.
- `tests/browser.test.ts`: كشف المتصفح بالترتيب الصحيح (`PUPPETEER_EXECUTABLE_PATH` ← `BROWSER_EXECUTABLE` ← المسارات المعروفة)، حل المسارات النسبية من مجلد الأداة، ورسائل الخطأ الواضحة عند مسار مضبوط غير موجود أو عند غياب أي متصفح. كلها تعمل عبر دالة فحص محقونة (mock paths) فلا تحتاج Chrome حقيقيًا، باستثناء حالة واحدة تنشئ ملفًا تنفيذيًا مؤقتًا وتتحقق من كشفه فعليًا على القرص.
- `tests/doctor.test.ts`: تشغيل المتصفح المكتشف عبر `puppeteer-core` بمحاكاة، وإغلاقه حتى عند فشل الفحص.
- اختبارات Python داخل `tests/python/`: **توليد WAV حقيقي** واختبار قنواته ومدته ومستواه، توقيت الصوت، أوامر FFmpeg/SadTalker وحماية الاتصال. اختبارات Notebook تتحقق من فصل خلايا shell عن خلايا Python ومن تثبيت `chromium-browser` ومن ضبط متغيرات المتصفح قبل خلية التشغيل، ثم تنفّذ نص خليتي الوصف والتشغيل مع محاكاة subprocess والعرض، وتتحقق من تمرير القيم حرفيًا ومنع عرض فيديو قديم عند الفشل؛ ليست اختبار Run All على Colab.
- اختبارات تنزيل الصورة تشغّل خلية Colab 6 وسكربت التنزيل بتنزيل **وهمي محلي**: تنشئ الملف عند فقدانه/فراغه، ولا تستبدل صورة موجودة، وترفض البيانات الفارغة أو غير الصالحة وتزيل الملفات المؤقتة. لا تتصل بـUnsplash أثناء الاختبارات.
- لا تنزّل الاختبارات نماذج، ولا تستدعي Piper أو SadTalker فعليًا، ولا تشغّل Chrome أو render حقيقيًا.
- `.github/workflows/video-agent-test.yml` يشغّل هذه الاختبارات على كل PR باستخدام Node وPython، دون Torch أو SadTalker. GitHub Actions خدمة CI فقط وليست جزءًا من تشغيل الإعلان. يمكنك تشغيل الأوامر نفسها داخل Codespace أو على جهازك.

**نطاق التحقق:** اختبارات الوحدات والتجميع لا تثبت عمل الاستدلال الثقيل على جهازك. يجب تنفيذ إعلان تجريبي محلي بعد تثبيت النماذج والصورة والمتصفح وقبول تراخيصها؛ لا نزعم إجراء اختبار end-to-end بنماذج كاملة في هذه البيئة.

## 7. أخطاء شائعة

- **ملف الصورة مفقود أو فارغ:** أعد تشغيل خلية Colab 6 أو `bash python/setup_models.sh` أثناء الاتصال، أو ضع صورتك في `assets/avatars/man-1.png` واضبط `DEFAULT_AVATAR` إن استعملت مسارًا آخر. لا يُنزّل `npm start` شيئًا أثناء التوليد.
- **المتصفح غير مثبت أو غير مكتشف:** راجع [قسم المتصفح](#المتصفح-chromiumchrome) و[استكشاف الأخطاء](#8-استكشاف-الأخطاء).
- **Piper غير موجود:** فعّل `.venv` أو اضبط `PYTHON_BIN`.
- **تعارض NumPy/Torch/Pillow:** استخدم `.venv-sadtalker` المنفصلة مع Python 3.10، لا Python الموقع أو بيئة Piper.
- **الصوت لا يناسب المشهد:** اختصر النص/اسم المنتج أو زد المدة.
- **لا وجه مكتشف:** استخدم صورة واضحة أمامية لشخص واحد.
- **CUDA غير متاح:** اختر `AVATAR_DEVICE=cpu` أو ثبّت تعريفات/PyTorch المناسبين.
- **خط عربي غير ظاهر:** ثبّت خطًا عربيًا محليًا أو اضبط WOFF2.
- **فشل مرحلة:** رمز خروج غير صفري، لا رسالة نجاح وهمية ولا رجوع لخدمة خارجية. احتفظ بسجل الخطأ والملفات الوسيطة للتشخيص.

## 8. استكشاف الأخطاء

### المتصفح: `لم يتم العثور على Chrome/Chromium مثبّت على هذا الجهاز`

لم يُعثر على متصفح في أي مسار مفحوص ولم يُضبط أي متغير بيئة.

```sh
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y chromium-browser
which chromium-browser chromium google-chrome google-chrome-stable
# حدّد المسار يدويًا إن كان في مكان آخر
BROWSER_EXECUTABLE=/usr/bin/chromium npm start
```

### المتصفح: `ملف المتصفح المضبوط في BROWSER_EXECUTABLE غير موجود`

المسار مضبوط لكنه غير موجود (مثل نسخ `.env` من جهاز آخر). لا تنتقل الأداة بصمت إلى متصفح آخر: صحّح المسار أو احذف المتغير للسماح بالكشف التلقائي. الرسالة تسرد المتصفحات المكتشفة على الجهاز إن وُجدت.

### المتصفح في Google Colab

الخطأ `invalid_type ... BROWSER_EXECUTABLE` يعني أن المتغير لم يُضبط قبل تشغيل `npm start`. الأسباب الشائعة:

1. **خلية التثبيت لم تكتمل:** شغّل خلية shell التي تحتوي `!apt-get install -y -qq chromium-browser` أولًا.
2. **ترتيب الخلايا:** شغّل خلية Python (7) التي تضبط `BROWSER_EXECUTABLE` و`PUPPETEER_EXECUTABLE_PATH` قبل خلية التشغيل (9).
3. **خلط shell مع Python في خلية واحدة** ينتج `IndentationError` ولا تُنفَّذ الخلية أصلًا؛ خلايا shell منفصلة عن خلايا Python في هذا الـNotebook.
4. **جلسة جديدة:** يعيد Colab تصفير البيئة؛ أعد تشغيل الخلايا بالترتيب.

للتحقق داخل Colab:

```python
!which chromium-browser chromium google-chrome
import os
print(os.environ.get("BROWSER_EXECUTABLE"))
```

### المتصفح موجود لكنه لا يعمل

شغّل الفحص المخصّص؛ سيحاول تشغيل المتصفح عبر `puppeteer-core` وطباعة إصداره، بعد التحقق من `ffmpeg` و`ffprobe`:

```sh
npm run doctor
```

إذا فشل التشغيل، فالمشكلة عادة في مكتبات النظام الناقصة أو في بيئة محكومة (container) تحتاج `--no-sandbox`؛ `doctor` يستخدم هذه الوسيلة مسبقًا. الأداة لا تعدّل إعدادات أمان النظام نيابة عنك.
