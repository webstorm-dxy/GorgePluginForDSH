# Gorge Chart Framework / Dremu Chart Form — Technical Specification

Status: reverse-engineered from a live GorgeStudio project (Unity 2022.3-era) and
from real shipped chart data. Everything below is grounded in files on this
machine; every non-obvious claim carries a path (and line numbers where useful).

Scope: the `.g` chart text format, the `Dremu` chart form, the value/curve type
system, the time model, and the `chartstudio` editor's architecture and HTTP API.

Audience: anyone writing a parser/emitter/serialiser for `.g` charts, or an
external editor that must round-trip them.

---

## 0. Sources

| Path | What it is | What it gave us |
|---|---|---|
| `/Users/daxingyi/UnityProject/GorgeStudio/` | Unity project hosting the chart editor | everything structural |
| `.../Packages/cn.starbow.gorge.chartstudio/` | In-game chart editor, 118 C# files | UX, edit actions, HTTP API |
| `.../Packages/cn.starbow.gorge.unity/` | Gorge language runtime, compiler, framework adaptor | ANTLR grammars, C# framework classes |
| `.../Runtime/Gorge/GorgeCompiler/GorgeCompiler/src/*.g4` | **the actual grammar** (`Gorge.g4`, `GorgeLexerRules.g4`, `GorgeExpression.g4`, `GorgeStatement.g4`) | section B |
| `.../Packages/cn.starbow.gorge.sampleforms/` | 102 `.g` files: `Dremu`, `Deenty`, `DeentyStoryboard`, `Reincal` forms | section C |
| `Assets/Resources/Native.zip` | 98 `.g` files: the *native* (`native class`) declarations of the framework | sections C, D |
| `Assets/Resources/Forms/Dremu.bytes` | a **zipped form package** (sources + `FormAsset/*.png|wav`) | section A |
| `Library/ScriptAssemblies/cn.starbow.gorge.unity.dll` | compiled framework (`Gorge.Native.GorgeFramework.*`) | IL decompilation for math/defaults |
| `/Users/daxingyi/Music/DremuTest/` | real Dremu project: 5 `.g`, 5 PNG, 1 WAV (46 MB) | sections A, C, G, H |
| `/Users/daxingyi/Music/Chart/{Chart,Chart 2,Chart 3,Chart 4,Aurora,ProiProi}` | older/hand-written charts | grammar edge cases |

Notes on method: the framework's `.g` sources are a git submodule that is **not
checked out** (`Packages/cn.starbow.gorge.unity/Runtime/Gorge/GorgeFramework/GorgeFramework`
is an empty gitlink), but (a) the *native* declarations survived inside
`Assets/Resources/Native.zip`, and (b) the compiled assembly still contains every
field, default and method body. Field tables and formulas below were recovered by
`ikdasm`-disassembling `cn.starbow.gorge.unity.dll` and reading
`InjectorFieldDefaultValue_*` / `Evaluate` method bodies.

---

# A. File / project structure

## A.1 A chart project is a `Package`

`Gorge.GorgeFramework.Chart.Package` (`Package.il`) is nothing more than:

```csharp
class Package {
    List<AssetFile>      AssetFiles;      // path + byte[]
    List<SourceCodeFile> SourceCodeFiles; // path + UTF-8 text + IsChartSourceCode
}
```

`Package.LoadFolderPackage(path, isChart)` enumerates a directory;
`Package.LoadZipPackage(path|bytes|stream, isChart)` enumerates zip entries
(SharpZipLib). In **both** cases the split is purely by extension:

* file name ends with `.g` → decoded as UTF-8 text → `SourceCodeFile`
* everything else → raw bytes → `AssetFile`

The `isChart` flag is copied into `SourceCodeFile.IsChartSourceCode`; the editor
passes `false` for form packages and `true` for the chart
(`EditorManager.Awake`, `.../chartstudio/Runtime/Scripts/GorgeEditor/EditorManager.cs`):

```csharp
Forms.Add(GorgeNative.GorgeCommonLibPackage());
Forms.Add(Package.LoadFolderPackage("./Packages/cn.starbow.gorge.sampleforms/DeentyStoryboard", false));
var dremu = Package.LoadFolderPackage("./Packages/cn.starbow.gorge.sampleforms/Dremu", false);
...
LoadChart(Package.LoadZipPackage("./DremuTest.zip", true));
```

So a chart may be a **directory** or a **`.zip`** (same layout). `DremuTest.zip` in
the GorgeStudio root is exactly `zip(DremuTest/)`.

The editor's *Save* path (`TopBarManager.Save` →
`SimulationScore.ExportChartPackage().SaveZipPackage(path)`) always writes a zip:

* one entry `<StaffClassName>.g` per staff class (only classes with
  `IsChartClass == true`, i.e. discovered via `@ElementStaff` / `@AudioStaff`),
* one entry `<AssetLoaderName>.g` for each asset loader (normally `AutoLoaded.g`),
* all `AssetFile`s byte-for-byte.

## A.2 What files make up a project

`/Users/daxingyi/Music/DremuTest/` is the canonical example:

| File | Bytes | Role |
|---|---|---|
| `Song.g` | 415 | `@AudioStaff class Song` + `@Song` → the audio track |
| `DremuStaff.g` | 40 692 | `@ElementStaff class DremuStaff`, 1 period, 11 × `Dremu.DremuMainLane` (background "ArtLine" curves) |
| `DremuStaff1.g` | 395 989 | `@ElementStaff class DremuStaff1`, **20 periods**, 219 elements, period offsets `0.0 … 107.1053` (main chart: taps/drags/holds/tapliks + main lanes) |
| `DremuStaff2.g` | 505 726 | `@ElementStaff class DremuStaff2`, **11 periods**, 268 elements (second half / guide-lane heavy) |
| `DeentyStoryboardStaff.g` | 9 010 | `@ElementStaff class DeentyStoryboardStaff`, form `DeentyStoryboard`, 8 `Image` elements (backgrounds) |
| `Song.wav` | 46 129 904 | audio (float32 stereo 44.1 kHz, 130.75 s) |
| `Background1..4.png`, `Block.png` | small | referenced as `image:Background1` … |

There is **no manifest, no index, no `.json`** anywhere: the set of `.g` files is
the project. Staff order in the editor comes from class discovery order, not from
file names.

## A.3 Staff files and class naming

* One `class` per file is the convention (the exporter writes `<ClassName>.g`), and
  a class name must be unique across the whole project.
* The file name is *not* semantically meaningful to the parser; only the class
  declaration and its annotations matter. Hand-written files with several classes
  would parse, but the editor would re-export them one-per-file.
* Multiple staff files = multiple staff classes = multiple horizontal tracks in the
  editor. Multiple *periods* inside one staff = several `@Chart` methods (see A.6).

Two staff kinds exist:

| Annotation | Class | Carries | Notes |
|---|---|---|---|
| `@ElementStaff` | `ElementStaff : Staff<ElementPeriod>` | `string form`, `string displayName` metadata, N × `@Chart` methods | the actual note/art data |
| `@AudioStaff` | `AudioStaff : Staff<AudioPeriod>` | `string displayName` metadata, N × `@Song` methods | audio track(s) |

`ElementStaff` **requires** metadata `form` — `SimulationScore.ExtractStaveFromRuntime`
throws if it is missing; `displayName` is optional (defaults to the class name).
`AudioStaff` has no `form`; its `displayName` is likewise optional.

The `form` string must match a form registered by a `@Form`-annotated class
(`Dremu.g`: `@Form(name = "Dremu", version = "0.1")`), otherwise the editor cannot
resolve element types for that staff (`EditorFormContainer.FormElements[formName]`
would be missing) and `addSimpleTapNote`-style APIs fail with
`没有找到名为Dremu的模态`.

## A.4 Assets: how images/audio/video are referenced

There is no path syntax. On load, **every non-`.g` file of the package is
auto-registered** by extension (`SimulationScore.AddFileAsset`, IL):

| Extension | Registered as | Name format |
|---|---|---|
| `.png`, `.jpg` | `GorgeFramework.ImageAsset` (Texture2D decoded via `ImageConversion.LoadImage`) | `image:<filename-without-ext>` |
| `.wav`, `.mp3`, `.ogg` | `GorgeFramework.NativeAudioAsset` | `audio:<filename-without-ext>` |
| `.mp4` | `GorgeFramework.NativeVideoAsset` | `video:<filename-without-ext>` |

All of them are collected into an in-memory `AssetSet` named **`AutoLoaded`**
inside an `AssetLoader` named **`AutoLoaded`**, which the exporter writes as
`AutoLoaded.g` (an `@Asset` staff):

```
[
    string displayName = ...
]
@Asset
static GorgeFramework.Asset^[] <Name>()
{
    return new GorgeFramework.Asset^[N]{ ... };
}
```

Consequences for a generator:

* `assetName : "image:Background1"` refers to `Background1.png` **in the package
  root**; the name is the *file name* (extension stripped), **not** a path. Two
  images with the same file name in different folders collide.
* The lookup at runtime is `Environment.GetAssetByName(assetName)`, which searches
  the loaded asset table. A missing asset yields `null` and typically a
  `NullReferenceException` in the element constructor (e.g. `Image()` does
  `(ImageAsset)Environment.GetAssetByName(assetName)` then `.texture`).
* Audio referenced from `Song.g` is *not* registered this way — it uses a
  `wavFilePath` (see A.5).

## A.5 `Song.g` — the audio staff

`/Users/daxingyi/Music/DremuTest/Song.g` in full:

```
[
    string displayName = "音频"
]
@AudioStaff
class Song
{
    [
        GorgeFramework.PeriodConfig^ config = GorgeFramework.PeriodConfig : {
            timeOffset : 0.373,
        }
    ]
    @Song
    static GorgeFramework.AudioAsset^ GetSong()
    {
        return GorgeFramework.WavAudioAsset : {
            name : "Song",
            wavFilePath : "Song.wav",
        };
    }
}
```

Semantics (from `SongSimulator` IL, method that drives playback):

```csharp
start = period.Config.timeOffset;            // 0.373
end   = start + audioSource.clip.length;
if (chartTime >= start && chartTime < end) {
    if (!audioSource.isPlaying) { audioSource.time = chartTime - start; audioSource.Play(); }
} else if (audioSource.isPlaying) audioSource.Stop();
```

So **`timeOffset` on the audio staff is the chart time at which the audio begins**
(the chart timeline is `audio_time + 0.373`). Playback is seek-accurate, so an
editor can scrub freely.

`@Song` **requires** metadata `config` (a `PeriodConfig^` injector) — the loader
throws otherwise. `@Song`'s return value must be an *injector* of an `AudioAsset`
subclass; `GorgeFramework.WavAudioAsset` is the only one in practice and takes
`wavFilePath` (relative to the package root) plus the inherited `name` field.

## A.6 Periods (multiple `@Chart` methods in one staff)

`DremuStaff1.g` has 20 `@Chart` methods named `Period`, `Period1`, … `Period19`;
`DremuStaff2.g` has 11. Each is an independent *period*: its own `config`
(`timeOffset`, `minLength`) and its own element array. Names only have to be unique
within the staff (the editor's rename dialog validates "方法名" only loosely), and
`Period`, `Period1`, `Period2` … is the editor's own naming habit.

Periods are **not sorted** in the file and need not be time-ordered — e.g.
`DremuStaff2.g` carries `timeOffset` values 11.10526, 12.36842, 13.63158, 14.89474,
**19.94737, 18.68421, 17.42105, 16.15789**, 28.78947, 59.10526, 84.36842. The
runtime merges all periods of all staffs into one timeline.

## A.7 Storyboard staff

`DeentyStoryboardStaff.g` uses form `DeentyStoryboard` and `DeentyStoryboard.Image`
elements with `assetName`, `startMoment`, `keepTime`, `positionMode`, `positionZ`,
`scaleY`, `alpha`. It is an ordinary `@ElementStaff`; the "storyboard" part is just
another form whose elements happen to be full-screen images
(`@EditableElement(type = "图片", editUpdateMode = EditUpdateMode.ReInject)`).

## A.8 Forms vs charts (two different package kinds)

A **form** (a plugin set of element types) is also a `Package`, and the shipped one
is a `.bytes` file — which is a zip:

```
$ unzip -l Assets/Resources/Forms/Dremu.bytes
Dremu.g                     Dremu/FormAsset/{Tap,Drag,Taplik,Heart,RespondHint}.png
DremuNativeResources.g      Dremu/FormAsset/RespondEffect.wav
Lane/*.g  Note/*.g  RespondHint/*.g
```

i.e. the form package = its `.g` sources + `FormAsset/` binaries. Forms are loaded
with `isChart = false` and are *not* part of a chart project; a chart only names a
form through `string form = "Dremu"`.

`Dremu.g` — the form entry point:

```
using Gorge;
using GorgeFramework;
namespace Dremu;

class Dremu
{
    @Form(name = "Dremu", version = "0.1")
    static string[] ElementTypeList()
    {
        return new string[6]{"Dremu.DremuTap", "Dremu.DremuDrag", "Dremu.DremuTaplik",
                             "Dremu.DremuHold", "Dremu.DremuMainLane", "Dremu.DremuGuideLane"};
    }
}
```

`ElementTypeList()` is what populates the editor's element palette; a class that is
not listed there is invisible to the UI even if it exists
(`Dremu.DremuNote`, `Dremu.DremuHoldInnerNote` are abstract/embedded and correctly
absent).

---

# B. The `.g` text format

## B.1 What the format actually is

`.g` is **not** a bespoke config format — it is source code in *Gorge*, a small
statically-typed OO language (classes, interfaces, enums, generics, delegates,
`if/for/while/switch`, a VM/IL backend) whose grammar is ANTLR4. Chart files use a
tiny **declarative subset** of it: class declarations + annotations + object
literals + `return`.

That is why:

* the loader "executes" `Period()` — `GorgeClass.InvokeStaticMethod` runs the IL
  and gets an `ObjectArray` of `Injector`s back (`SimulationScore.ExtractStaveFromRuntime`);
* values in the file are *expressions*, and the sample forms do use lambdas,
  ternaries, `new`, loops and string concatenation (see `Image.g`'s `display`
  metadata delegate);
* the editor re-emits the whole file from an AST (`ToGorgeCode`), which is why the
  formatting is so mechanical and uniform.

Grammar files (authoritative):

```
.../cn.starbow.gorge.unity/Runtime/Gorge/GorgeCompiler/GorgeCompiler/src/
    Gorge.g4            (153 lines) sourceFile / class / enum / annotation / metadata
    GorgeLexerRules.g4  (163 lines) tokens, literals, comments
    GorgeExpression.g4  (214 lines) expressions, injector literals, type suffixes
    GorgeStatement.g4   (108 lines) statements and blocks
```

## B.2 Lexical rules (verbatim highlights from `GorgeLexerRules.g4`)

Comments — both are `-> channel(HIDDEN)`, i.e. ignored entirely:

```
LineComment  : '//' ~[\r\n]* ;
BlockComment : '/*' .*? '*/' ;
```

Whitespace/newlines are hidden too (so the format is free-form; indentation is
purely cosmetic).

String literals:

```
StringLiteral : '"' StringCharSequence? '"' ;
fragment StringChar
    : ~["\\\r\n]        // any char except quote, backslash, CR, LF
    | EscapeSequence ;
fragment EscapeSequence
    : '\\' ["nr\\] ;    // ONLY \"  \n  \r  \\   (no \t, no \uXXXX)
```

Consequences: a raw newline or `\t` escape inside a string is a **syntax error**;
CJK text is fine (the file is UTF-8).

Numbers:

```
IntLiteral   : NonzeroDigit Digit* | '0' ;
FloatLiteral : IntLiteral '.' Digit+ ;
```

There is **no exponent notation** (`1e-3` is invalid), **no leading dot** (`.5`
invalid), **no trailing dot** (`1.` invalid), **no hex**, and **no sign** — `-1.0`
is the unary operator applied to `1.0`. Every `.g` writer emits floats with an
explicit decimal point (`0.0`, not `0`).

Identifiers: `[a-zA-Z_][a-zA-Z0-9_]*`. Keywords are reserved (`class`, `enum`,
`interface`, `static`, `native`, `new`, `this`, `super`, `null`, `default`, `if`,
`else`, `for`, `while`, `do`, `switch`, `case`, `return`, `break`, `continue`,
`inject`, `injector`, `delegate`, `invokes`, `void`, `int`, `float`, `bool`,
`string`, `object`, `auto`, `using`, `namespace`, `true`, `false`, `extends`), so
**field names like `class`, `default`, `value`, `new` would collide** — in practice
only `value` (fine) occurs.

Punctuators that matter for charts: `{ } [ ] ( ) < > , : ; . @ ^ =` and `::` `->`.

## B.3 Grammar, chart-relevant excerpt

From `Gorge.g4`:

```
sourceFile      : (classDeclaration | enumDeclaration | interfaceDeclaration
                  | usingStatement | namespaceStatement)* ;

classDeclaration: annotation* classModifier* Class Identifier genericsDeclaration?
                  superclass? superInterfaces? LeftCurlyBracket classBody RightCurlyBracket ;
classModifier   : Native ;
superclass      : Colon expression ;                 // `: DremuLane`
superInterfaces : '::' expression (Comma expression)* ;  // `:: ITransformer`
classBody       : memberDeclaration* ;
memberDeclaration: fieldDeclaration | methodDeclaration | constructorDeclaration ;

fieldDeclaration: annotation* expression Identifier ('=' expression)? ';' ;
                 //  ^type   ^name              ^initializer

methodDeclaration : annotation* methodModifier* expression Identifier parameterList
                    (codeBlockList | ';') ;      //  ^return type (an expression!)
methodModifier    : Static ;

annotation        : metadata? annotationIdentifier genericType? annotationParameters? ;
annotationIdentifier : '@' Identifier ;
annotationParameters : '(' (annotationParameter (Comma annotationParameter)*)? ')' ;
annotationParameter  : Identifier '=' expression ;

metadata         : '[' (metadataEntry (Comma metadataEntry)*)? ']' ;
metadataEntry    : expression Identifier ('=' expression)? ;   // <type> <name> [= <value>]

usingStatement    : Using (Identifier '=')? expression ';' ;
namespaceStatement: Namespace Identifier ('.' Identifier)* ';' ;
```

From `GorgeExpression.g4` (the part that *is* the chart data model):

```
unaryLeftAssociativityLevelExpression
    : ...
    | <expr> ':' objectInjector      # InjectorLiteral      // Type : { ... }
    | <expr> ':' arrayInjector       # ArrayInjectorLiteral // Type : { a, b, }
    | <expr> '^'                     # TypeInjector         // Element^
    | <expr> '[' ']'                 # TypeArray            // Element^[]
    | <expr> '<' expression '>'      # TypeGenerics         // Inject<VariableFloat^>
    ;

objectInjector
    : '{' keyValuePair (',' keyValuePair)* ','? '}'   # NonemptyObjectInjector
    | '{' ':' '}'                                     # EmptyObjectInjector
    ;
arrayInjector
    : '{' expression (',' expression)* ','? '}'       # NonemptyArrayInjector
    | '{' ',' '}'                                     # EmptyArrayInjector
    ;
keyValuePair : Identifier ':' expression ;
```

`primaryLevelExpression` also allows `New <type> '(' args ')' objectInjector?` and
`New <type> '[' n ']' arrayInjector?` — the latter is how the `@Chart` body is
written.

### B.3.1 Mini-BNF for the chart subset (what a codec must accept)

```
file            ::= { using-stmt | class-decl } EOF

using-stmt      ::= "using" [ IDENT "=" ] expr ";"

class-decl      ::= staff-decl | form-decl
staff-decl      ::= { metadata } "@ElementStaff" "class" IDENT "{" { member } "}"
                  | { metadata } "@AudioStaff"   "class" IDENT "{" { member } "}"
form-decl       ::= "class" IDENT "{" "@Form" "(" "name" "=" STRING ... ")"
                    "static" "string" "[" "]" "ElementTypeList" "(" ")" block "}"

member          ::= { metadata } "@Chart" "static" "Element" "^" "[" "]" IDENT
                    "(" ")" "{" "return" "new" "Element" "^" "[" INT "]" array-body ";"
                    "}"
                  | { metadata } "@Song"  "static" "AudioAsset" "^" IDENT
                    "(" ")" "{" "return" object-body ";" "}"

metadata        ::= "[" meta-entry { "," meta-entry } "," "]"
meta-entry      ::= TYPE IDENT [ "=" value ]
(* a metadata block binds to the annotation that immediately follows it — see B.4 *)

array-body      ::= "{" [ value { "," value } "," ] "}"     // element list
object-body     ::= TYPE ":" "{" [ IDENT ":" value { "," IDENT ":" value } "," ] "}"
                  | TYPE ":" "{" ":" "}"                     // empty object  Type : { : }
                  | TYPE ":" "{" "," "}"                     // empty array   Type : { , }
value           ::= scalar | object-body | array-of-objects | "null"
scalar          ::= FLOAT | INT | BOOL | STRING | ENUM-REF   // EnumType.Value
array-of-objects::= TYPE "^" ":" "{" object-body { "," object-body } "," "}"
```

Everything else the language supports (`if`, `for`, lambdas, `switch`, …) is legal
in `.g` but is never emitted by the editor into chart data; a codec only needs it
for *form* files (`display`/`elementLine`/`check` metadata delegates) and for legacy
hand-written charts.

## B.4 The `[...]` + `@Annotation` model (the single most important subtlety)

`annotation : metadata? annotationIdentifier ...` — a **bracket block immediately
preceding an annotation becomes that annotation's metadata**, *not* a standalone
declaration. There is no "attribute block" separate from annotations.

Three flavours appear in chart files:

**(1) Annotation parameters — `(name = value)`:**

```
@EditableElement(type = "轨道", editUpdateMode = EditUpdateMode.RePlay)
@Form(name = "Dremu", version = "0.1")
@DisplayName(name = "全屏覆盖")
```

**(2) Annotation metadata — the `[...]` block, typed entries:**

```
[
    string form = "Dremu",
    string displayName = "表演"
]
@ElementStaff
class DremuStaff
```

`form` and `displayName` are metadata of `@ElementStaff`. Likewise:

```
[
    GorgeFramework.PeriodConfig^ config = GorgeFramework.PeriodConfig : { timeOffset : 1.0, }
]
@Chart
static GorgeFramework.Element^[] Period()
```

`config` is metadata of `@Chart`. And in element classes, the per-field editor
metadata is metadata of `@Inject`:

```
[
    auto defaultValue = VariableFloat : {baseValue : 0.0},
    string type = "基本",
    int order = 1,
    string displayName = "X坐标",
    string information = "标准坐标系|横轴为谱面时间，单位秒；...",
    delegate<bool:VariableFloat^> check = bool:(VariableFloat^ positionX) -> { return true; }
]
@Inject<VariableFloat^>
VariableFloat positionX = new ^positionX();
```

**(3) Both at once** — `@Editor(code = "...")` *then* a `[...]` block then `@Inject`
(the `@Editor` annotation has no metadata, the `[...]` belongs to `@Inject`); see
`DeentyStoryboard/Image/StoryboardEntity.g`, field `alpha`.

Metadata entries are **typed declarations**: `<type> <name> [= <value>]` where
`<type>` may be `auto` (infer). `[auto defaultValue]` with no value means "this
field has a default value which is defined elsewhere" (native classes); with a
value it *is* the default (form classes).

Metadata keys the tooling actually reads (all verified in C#):

| Owner | Key | Type | Meaning |
|---|---|---|---|
| `@ElementStaff` | `form` | string | **required**; form name (`"Dremu"`) |
| `@ElementStaff`, `@AudioStaff` | `displayName` | string | track label; default = class name |
| `@Chart`, `@Song` | `config` | `PeriodConfig^` | **required** |
| `@Inject` (field) | `defaultValue` | any | value used when the field is omitted; also the editor's "default" toggle |
| `@Inject` (field) | `type` | string | UI group in the inspector (`基本`, `生命周期`, `效果`, `其他`) |
| `@Inject` (field) | `order` | int | sort key inside the group |
| `@Inject` (field) | `displayName` | string | inspector label; default = field name |
| `@Inject` (field) | `information` | string | help text; the editor shows it as the input's placeholder (`TextEditor.cs`). The `|` seen in shipped strings is an authoring convention for "summary|detail", **not** split by the editor |
| `@Inject` (field) | `check` | `delegate<bool:T^>` | validation predicate run by the editor |
| `@EditableElement` | `display`, `color` | `delegate<string:T^>` / `ColorArgb^` | **required** — `EditableElementContainer` throws without them; `display` returns the list label, `color` the swatch |
| `@EditableElement` | `elementLine` | `delegate<ElementLine:T^>` | *optional* — timeline bar for the period block; skipped when absent (`ElementPeriodEditor.ChartToElementLines`) |

## B.5 Injectors: `^`, `T : { ... }`, `new ^x()`

`^` marks an **injector type**: a recipe/blueprint for an object rather than the
object. `GorgeFramework.Element^[]` is "array of element injectors";
`GorgeFramework.Element^[11]{ ... }` constructs such an array. An object literal
`Dremu.DremuTap : { ... }` has type `Dremu.DremuTap^`.

Injector *values* (not just types) can be stored in fields — that is how nested
elements are expressed:

```
color : GorgeFramework.LerpColorCurve : {
    colorPoints : GorgeFramework.ColorArgb^ : {
        GorgeFramework.ColorArgb : { a : 0.0, r : 0.0196, g : 0.7608, b : 0.5882, },
        GorgeFramework.ColorArgb : { a : 1.0, r : 0.0196, g : 0.7608, b : 0.5882, },
    },
    progressCurve : GorgeFramework.LinearCurve : { timeStart : -0.6, timeEnd : -0.3, },
},
```

Note the array form: the *element* type prefix appears once
(`GorgeFramework.ColorArgb^ : { ... }`), then each item is written as a bare
`Type : { ... }` (or, in older hand-written files, with the type repeated).

Related syntax in form sources (not in chart files, but a codec should not choke):

* `new ^field()` — instantiate from the injector stored in `field`
* `new (^array)[^array.length]` — instantiate an array of injectors
* `(^x == null) ? null : (new ^x())` — null-safe injection
* `^field` — read the *injector's* field (`.^name` is injector member access)
* `new ConstantFunctionCurve(){value : 0.0}` — constructor + object literal
* `bool:(VariableFloat^ x) -> { ... }` — lambda / delegate literal, type `delegate<bool:VariableFloat^>`

## B.6 The staff-file template (exact)

`ElementStaff.ToGorgeCode()` (IL) emits, byte for byte:

```
[
    string form = <StringLiteral(FormName)>,
    string displayName = <StringLiteral(DisplayName)>
]
@ElementStaff
class <ClassName>
{
<period 1 code, indented 1>
<blank line>
<period 2 code, indented 1>
<blank line>
}
```

`ElementPeriod.ToGorgeCode(1)` emits:

```
    [
        GorgeFramework.PeriodConfig^ config = <injector>
    ]
    @Chart
    static GorgeFramework.Element^[] <MethodName>()
    {
        return new GorgeFramework.Element^[<n>]<array injector>;
    }
```

`AudioStaff.ToGorgeCode()` / `AudioPeriod.ToGorgeCode()` are analogous:
`[ string displayName = ... ] @AudioStaff class X { ... }` and
`[ GorgeFramework.PeriodConfig^ config = ... ] @Song static GorgeFramework.AudioAsset^ <Name>() { return <injector>; }`.

Compare with the real file `/Users/daxingyi/Music/DremuTest/DremuStaff.g:1-24` —
identical, including the blank line after each period and the trailing newline.

## B.7 Emission rules (what the editor writes; mimic these to get zero-diff round-trips)

From `Gorge.GorgeFramework.InjectorHardcodeGenerator` (IL) and
`StringBuilderExtension`:

1. **Indent = 4 spaces per level.** Never tabs.
2. **Object literal**: first line `Type : {`; one line per *non-default* field,
   `name : value,` (comma always, including the last field); closing `}` appended at
   the parent indentation with **no** trailing comma after `}`.
   If nothing is emitted: `Type : { : }`.
3. **Array literal**: `Type : {` when the element type prefix is wanted (top-level
   `return new Element^[n]{...}`, and nested injector arrays), else `{`;
   items one per line with a trailing `,`; then `}`. Empty: `Type : { , }` (or
   `{ , }` without the type prefix).
4. **Field order** = injector-field declaration order, base class first. The
   compiler assigns indices in that order (`ClassDeclaration.InjectorFieldCount` /
   `TryGetInjectorFieldById`), e.g. `DremuHold` always serialises
   `laneName, hitTime, leadTime, lagTime, position, distance, color, hintReference,
   respondHintColor1, respondHintColor2, positionZ, holdTime, innerNotes,
   endDistance, holdLine, truncation, holdLength, pointCount, targetProjectionFix`.
5. **Omitted fields = default.** `Injector` tracks a "default" bit per field
   (`GetInjectorFloatDefault(i)` etc.); the generator skips any field whose bit is
   set, and `FieldInitialize` likewise skips it, leaving the class's own initializer
   in place. This is why real files look sparse. In the inspector each field has a
   "默认值" checkbox (`DefaultToggleFieldEditor`), enabled only when the field
   declares a default (`Field.DefaultValueIndex != null`); ticking it marks the field
   default again, which is exactly what makes it disappear on the next save.
6. **Float format**: `"0.0######"` (up to 6 fractional digits, at least one).
   `float.PositiveInfinity → (1.0/0.0)`, `NegativeInfinity → (-1.0/0.0)`.
   Ints: `ToString()`. Bools: `true` / `false`. Enums:
   `HardcodeType() + "." + value`. Strings: quoted + escaped (only `\" \\ \n \r`).
7. **Type names are fully qualified** (`Dremu.DremuMainLane`,
   `GorgeFramework.PeriodConfig`), with `^` and `[]` suffixes as needed
   (`GorgeFramework.Element^[]`, `GorgeFramework.FunctionCurve^`).
8. **Line endings** are `StringBuilder.AppendLine()` = `Environment.NewLine`, so the
   shipped Windows-authored files are **CRLF** (`DremuStaff.g` is CRLF, UTF-8 **without**
   BOM; the sampleform sources *do* carry a BOM). The parser ignores both.

## B.8 Hand-written vs editor-written

`/Users/daxingyi/Music/Chart/Chart 2/DremuStaff.g` (2025-01) is hand-written and
differs in three ways, all legal:

* **unqualified type names** (`PeriodConfig`, `Element`, `DremuMainLane`, `Image`)
  instead of `GorgeFramework.PeriodConfig` / `Dremu.DremuMainLane`. That file has no
  `using` lines at all, so the compiler evidently pre-seeds `Gorge` +
  `GorgeFramework` (and older builds resolved the form namespaces too;
  `Chart 4/*.g` adds explicit `using Gorge; using GorgeFramework; using Dremu;`).
  Editor-written files are always fully qualified;
* **semantic field order** rather than declaration order, and only the fields the
  author cared about (e.g. a `CubicHermiteSpline` with just `endPoint`), relying on
  defaults for everything else;
* occasional `new Element^[0]{ , };` and other empty-container spellings that only
  hand-written files use.

Both styles must parse; for generation prefer the editor style (B.7), because that
is what `ToGorgeCode` produces and therefore what an editor round-trip will
compare against.

---

# C. Element type catalog

## C.1 Reading the tables

* **Type** column uses Gorge syntax; `T^` = injector of `T`, `T[]` = array.
* **Default** is the value used when the field is absent (from `[auto defaultValue = …]`
  in the `.g` source, cross-checked against `InjectorFieldDefaultValue_*` in the DLL).
* "—" in Default means **no default**: the field is effectively required (the class
  initializer is `= ^fieldName`, which yields `null`/`0` if omitted — which usually
  breaks the element at construction time). `laneName`, `name`, `assetName`,
  `mainLaneName` are the important required ones.
* Field order in the tables **is** the declaration order (= serialisation order).

## C.2 The framework base classes

`Assets/Resources/Native.zip/Element.g` — the *entire* base element:

```
native class Element
{
    ElementSimulator simulator;
    ElementSimulator lateIndependentSimulator;
    Node[] nodes;
    Element();
}
```

`Native.zip/Note.g`:

```
native class Note : Element
{
    SignalTsiga automaton;
    Note();
    IAutomatonCommand[] DoRespond(string respondMode, float respondChartTime);
}
```

**Key finding: `Element` has no `name`, `generateTime`, `keepTime`, `positionZ` or
`alpha`.** Those are declared by each *form's* own base class (`DremuLane`,
`StoryboardEntity`). The framework only guarantees `nodes` (renderables),
`simulator` / `lateIndependentSimulator` (transform pipeline) and, for notes,
`DoRespond`. Everything else — including the time fields — is a convention the form
and the editor agree on. (See section E.)

The C# side of `Element` (`Gorge.Native.GorgeFramework.Element`, from
`cn.starbow.gorge.unity.dll`) confirms exactly three public fields:
`simulator`, `lateIndependentSimulator`, `nodes`.

## C.3 `Dremu` form — base lane (`DremuLane`)

File: `Packages/cn.starbow.gorge.sampleforms/Dremu/Lane/DremuLane.g`
`class DremuLane : Element`, `@EditableElement(type = "轨道", editUpdateMode = RePlay)`.

| Field | Type | Default | Group / order | Meaning |
|---|---|---|---|---|
| `name` | `string` | — (required, `check`: `!= ""`) | 基本 0 | lane identifier used by `laneName` on notes |
| `generateTime` | `float` | `0.0` | 生命周期 1000 | appear time (s, period-local) |
| `keepTime` | `float` | `10.0` | 生命周期 1001 | lifetime (s, must be > 0) |
| `laneLines` | `FunctionCurve^[]^` | `FunctionCurve^ : { ConstantFunctionCurve : { value : 0.0 } }` | 基本 4 | shape of the judgement line; index = animation progress (multi-keyframe morph) |
| `animation` | `FunctionCurve^` | `LinearFunctionCurve : { k : 1.0, b : 0.0 }` | 基本 5 | maps `now - generateTime` to a (fractional) index into `laneLines` |
| `drawStartX` | `VariableFloat^` | `{ baseValue : -10.0 }` | 效果 2000 | left end of the drawn line, curve x = `now - generateTime` |
| `drawEndX` | `VariableFloat^` | `{ baseValue : 10.0 }` | 效果 2001 | right end |
| `pointCount` | `int` | `100` | 效果 2002 | polyline samples, > 1 |
| `evaluateDelta` | `float` | `0.01` | 效果 2003 | finite-difference epsilon for tangents/normals, > 0 |
| `color` | `ColorCurve^` | `null` | 效果 2004 | line colour over `now - generateTime` |
| `positionZ` | `float` | `-1.0` | 效果 2005 | draw order (smaller = front) |

Runtime behaviour (`DremuLane` methods in the `.g`):

```
EvaluateLaneLine(x, now):
    progress = animation.Evaluate(now - generateTime)
    i1 = clamp(floor(progress), 0, n-1); i2 = clamp(ceil(progress), 0, n-1)
    return (i1 == i2) ? curve[i1].Evaluate(x)
                      : lerp(curve[i1].Evaluate(x), curve[i2].Evaluate(x), progress - i1)
```

So the shape function is `y = f(x)` in **lane-local** coordinates, `x` spanning
`[drawStartX, drawEndX]` (evaluated per frame at `now - generateTime`).

## C.4 `Dremu.DremuMainLane` — the judgement line

`Dremu/Lane/DremuMainLane.g`, `class DremuMainLane : DremuLane`.
Adds three fields (inherits all of `DremuLane`):

| Field | Type | Default | Group / order | Meaning |
|---|---|---|---|---|
| `positionX` | `VariableFloat^` | `{ baseValue : 0.0 }` | 基本 1 | lane X offset |
| `positionY` | `VariableFloat^` | `{ baseValue : 0.0 }` | 基本 2 | lane Y offset |
| `rotationZ` | `VariableFloat^` | `{ baseValue : 0.0 }` | 基本 3 | lane rotation (degrees) |

⚠ **The `information` metadata says "横轴为谱面时间" (chart time) for these three
fields, but the shipped transformer does not do that.** `DremuMainLanePositionTransformer.g`
evaluates all of them at `t = now - lane.generateTime`:

```
IAutomatonCommand[] Transform(float now) {
    float t = now - lane.generateTime;
    lane.positionNode.position = new Vector3(positionX.EvaluateAdd(t), positionY.EvaluateAdd(t), -1.0);
    lane.positionNode.rotation = new Vector3(0.0, 0.0, rotationZ.EvaluateAdd(t));
    ...
}
```

So in the *current* Dremu form, **every** lane curve (`positionX/Y/Z`, `drawStartX`,
`drawEndX`, `color`, `laneLines` animation) is a function of **time since
`generateTime`**, not of absolute chart time. Trust the transformer sources over the
metadata strings (the strings are the form author's intent, the code is the truth).
The same applies to `DremuGuideLanePositionTransformer.g`, which uses
`t = now - lane.generateTime` for `position`.

Also declares the lifecycle contract used by the editor and the runtime:

```
@ForwardTimedGenerate  time = laneInjector.generateTime
@BackwardTimedGenerate time = laneInjector.generateTime + keepTime
@ForwardTimedDestroy   generateTime + keepTime
@BackwardTimedDestroy  generateTime
@EditTryGenerate       static TryGenerate(inj, t) => t >= generateTime && t <= generateTime + keepTime
@PeriodModifier        static PeriodModifier(inj, cfg) => inj.generateTime += cfg.timeOffset
```

## C.5 `Dremu.DremuGuideLane` — an auxiliary lane attached to a main lane

`Dremu/Lane/DremuGuideLane.g`, `class DremuGuideLane : DremuLane`.

| Field | Type | Default | Group / order | Meaning |
|---|---|---|---|---|
| `mainLaneName` | `string` | — (required) | 基本 1 | name of the `DremuMainLane` this guide line rides on |
| `position` | `VariableFloat^` | `{ baseValue : 0.0 }` | 基本 2 | offset along the main lane's normal, curve x = `now - generateTime` |
| `targetProjectionFix` | `bool` | `true` | 效果 2004 | project the offset onto the main line's tangent (else parallel to X) |

Its geometry is expressed *in the main lane's space*:

```
EvaluatePointPosition(x, distance, now):
    mainX = x + position.EvaluateAdd(now - generateTime) + EvaluateLaneLine(distance, now)
    return mainLane.EvaluatePointPosition(mainX, distance, now)
```

`DremuNote` resolves a lane by name, trying `Dremu.DremuMainLane` first and then
`Dremu.DremuGuideLane` (`Environment.FindAliveLane(typeName, laneName)`), so notes
can be attached to either kind.

## C.6 `Dremu.DremuNote` — note base

`Dremu/Note/DremuNote.g`, `class DremuNote : Note`.

| Field | Type | Default | Group / order | Meaning |
|---|---|---|---|---|
| `laneName` | `string` | — (required) | 基本 0 | owning lane name |
| `hitTime` | `float` | `0.0` | 基本 1 | hit time (s, ≥ 0, period-local) |
| `leadTime` | `float` | `1.5` | 生命周期 1000 | spawn this many seconds before `hitTime` |
| `lagTime` | `float` | `1.5` | 生命周期 1001 | destroy this many seconds after `hitTime` |
| `position` | `VariableFloat^` | `{ baseValue : 0.0 }` | 基本 2 | lateral position within the lane; curve x = `t - hitTime` |
| `distance` | `FunctionCurve^` | `LinearFunctionCurve : { k : -8.0, b : 0.0 }` | 基本 3 | distance from the judgement line; curve x = `t - hitTime` (k = -8 → approaches at 8 units/s) |
| `color` | `ColorCurve^` | `null` | 效果 2001 | note colour over `t - hitTime` |
| `hintReference` | `bool` | `false` | 效果 2002 | hit effect follows the lane |
| `respondHintColor1` | `ColorArgb^` | `null` → `ColorArgb(1,1,1,1)` | 效果 2003 | main flash colour |
| `respondHintColor2` | `ColorArgb^` | `null` → `ColorArgb(1,1,1,1)` | 效果 2004 | secondary flash colour |
| `positionZ` | `float` | `-2.0` | 效果 2005 | draw order |

Lifecycle: `@ForwardTimedGenerate hitTime - leadTime`,
`@BackwardTimedGenerate hitTime + lagTime`,
`@EditTryGenerate t ∈ [hitTime-leadTime, hitTime+lagTime]`,
`@PeriodModifier hitTime += cfg.timeOffset`.

`DoRespond(mode, chartTime)` implements scoring (`BestPerfect|Perfect|Good|Miss`),
calls `Environment.Scoring(...)`, plays the `RespondA` effect and spawns a
`DremuRespondHint`.

## C.7 Concrete note types

All four are `@EditableElement(type = "Note", editUpdateMode = EditUpdateMode.RePlay)`
and add nothing except their own visuals/automaton. Each has a `[display, color,
elementLine]` metadata block used by the element list and timeline.

| Type | File | Extra fields | Notes |
|---|---|---|---|
| `Dremu.DremuTap` | `Note/DremuTap.g` | — | single tap; `color` #05 66 8D-ish `(0.0196,0.4,0.5529)` |
| `Dremu.DremuDrag` | `Note/DremuDrag.g` | — | drag/scratch; `(0.945,0.953,0.745)` |
| `Dremu.DremuTaplik` | `Note/DremuTaplik.g` | — | flick; `(0.0118,0.7647,0.6)`; has private `flickBase` |
| `Dremu.DremuHold` | `Note/DremuHold.g` | see below | hold with inner notes |

`Dremu.DremuHold` adds:

| Field | Type | Default | Group / order | Meaning |
|---|---|---|---|---|
| `holdTime` | `float` | `1.0` | 基本 4 | hold duration (> 0) |
| `innerNotes` | `DremuHoldInnerNote^[]^` | `null` | 基本 5 | nested hit points |
| `endDistance` | `FunctionCurve^` | `LinearFunctionCurve : { k : -8.0, b : 0.0 }` | 基本 6 | tail distance curve (x = `t - releaseTime`) |
| `holdLine` | `FunctionCurve^` | `ConstantFunctionCurve : { value : 0.0 }` | 基本 7 | path of the hold body across the lane (x = `t - hitTime`) |
| `truncation` | `bool` | `true` | 基本 8 | truncate vs. compress the tail |
| `holdLength` | `float` | `1.0` | 基本 9 | reference length in truncation mode (≠ 0) |
| `pointCount` | `int` | `100` | 效果 2005 | samples for the body |
| `targetProjectionFix` | `bool` | `true` | 效果 2006 | project onto the lane tangent |

Lifecycle: generate at `hitTime - leadTime`, destroy at `hitTime + holdTime + lagTime`.

`Dremu.DremuHoldInnerNote` (`@Editable`, not an element):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `hitTime` | `float` | `1.0` | offset **relative to the hold's hitTime** (> 0) |
| `audioEffect` | `bool` | `true` | play the hit sound |
| `respondHint` | `bool` | `true` | show the hit effect |

## C.8 `DeentyStoryboard` form

`DeentyStoryboard/Image/StoryboardEntity.g`, `class StoryboardEntity : Element`
(an `Element` subclass that declares its own time base — again, no `generateTime`
here; the time field is called `startMoment`).

| Field | Type | Default | Group / order | Meaning |
|---|---|---|---|---|
| `assetName` | `string` | — (required) | 基本 0 | `image:...` asset name |
| `startMoment` | `float` | `0.0` | 基本 1 | appear time (s, period-local) |
| `keepTime` | `float` | `1.0` | 基本 2 | visible duration (> 0) |
| `positionMode` | `ImagePositionMode` | `ScreenX` | 基本 3 | coordinate system |
| `positionX` | `VariableFloat^` | `0.0` | 基本 4 | x; curve x = **progress** 0..1 (0 = appear, 1 = disappear) |
| `positionY` | `VariableFloat^` | `0.0` | 基本 5 | y, same progress base |
| `rotationZ` | `VariableFloat^` | `0.0` | 基本 6 | rotation |
| `scaleX` | `VariableFloat^` | `1.0` | 基本 7 | width scale |
| `scaleY` | `VariableFloat^` | `1.0` | 基本 8 | height scale |
| `positionZ` | `VariableFloat^` | `1.0` | 效果 1000 | draw order (larger = back; ±10 cull) |
| `alpha` | `VariableFloat^` | `1.0` | 效果 1001 | opacity 0..1 |
| `useChartTime` | `bool` | `false` | 基本 9 | curve argument: `false` → `(now - startMoment) / keepTime` (progress 0..1); `true` → `now - startMoment` (seconds) — see `EntityPositionTransformer.g` |

`DeentyStoryboard.Image` (`Image/Image.g`) adds no fields; it uses
`editUpdateMode = ReInject` (so it implements `@EditReInject`, `@EditTryGenerate`,
`@EditGenerate`) — this is the flag that selects the editor's *incremental* update
strategy. `ImagePositionMode`:

```
GamePlayPanel, ScreenXY, ScreenX, ScreenY, ScreenContain, ScreenCover
```

(with `@DisplayName(name = "...")` on each value).

`DeentyStoryboard.StoryboardVideo` exists (fields incl. 播放倍速/`speed`, plus a
`StoryboardVideoTransformer`) but is not used by any chart on this machine.

## C.9 Value types used inside elements

Declared in `Native.zip/System/*.g` and `Native.zip/Curve/**`:

| Type | Fields (order) | Defaults | Notes |
|---|---|---|---|
| `Vector2` | `x`, `y` | 0, 0 | also `Vector3` (`x,y,z`), `ColorArgb` (`a,r,g,b`, all default **1**) |
| `VariableFloat` | `baseValue:float`, `variationCurve:FunctionCurve^` | 0, null | see D.1 |
| `PeriodConfig` | `timeOffset:float`, `minLength:float` | **0.0**, **10.0** | see D.5 |
| `ElementLine` | `color:ColorArgb`, `points:ElementLinePoint[]` | — | editor-only timeline bar (from `@EditableElement` metadata `elementLine`) |
| `ElementLinePoint` | `time`, `position` (0..1), `width` (0..1) | — | `time` is **period-local seconds**; the editor draws it at `time / periodBlockLength` across the block (`ElementGraphRenderer`), so values outside the block are laid out off-clip |
| `LerpColorCurve` | `colorPoints:ColorArgb^[]^`, `progressCurve:FunctionCurve^` | null, null | see D.3 |
| `ConstantFunctionCurve` | `value` | 0 | |
| `LinearFunctionCurve` | `k`, `b` | 0, 0 | `k*x+b` |
| `QuadraticFunctionCurve` | `a`, `b`, `c` | 0,0,0 | `a*x²+b*x+c` |
| `CubicHermiteSpline` | `startPoint`, `startTangent`, `startWeight`, `endPoint`, `endTangent`, `endWeight` | `(0,0)`, 0, **1/3**, `(1,1)`, 0, **1/3** | default = identity ramp; D.2 |
| `PiecewiseFunctionCurve` | `functionPieces:FunctionPiece^[]^` | null | |
| `FunctionPiece` | `functionCurve`, `startX`, `endX`, `leftClosed`, `rightClosed` | null,0,0,false,false | |
| `PeriodicFunctionCurve` | `functionCurve`, `startX`, `endX`, `leftClosed` | null,0,0,false | periodic wrap |
| `AxialSymmetricFunctionCurve` | `functionCurve`, `axis`, `keepLeft` | null,0,false | mirror |
| `AdditionFunctionCurve` | `firstFunctionCurve`, `secondFunctionCurve` | | f1+f2 |
| `MultiplicationFunctionCurve` | `firstFunctionCurve`, `secondFunctionCurve` | | f1*f2 |
| `ArcFunctionCurve` | `chordStart`, `chordEnd`, `angle` | | circular arc over a chord |
| `LinearCurve` | `timeStart`, `valueStart`, `timeEnd`, `valueEnd` | **0, 0, 1, 1** | **Unity `AnimationCurve`-backed** (see D.2) |

The `LinearCurve` four-point form is what the Dremu charts use for fades:
`LinearCurve : { timeStart : -0.6, timeEnd : -0.3 }` keeps `valueStart = 0`,
`valueEnd = 1`, giving a 0→1 ramp between -0.6 s and -0.3 s relative to the hit
moment (Unity's `AnimationCurve` clamps before the first and after the last key, so
the colour is "off" before -0.6 and fully on after -0.3).

## C.10 Where the declarations live (map for future work)

| Symbol | Declared in | Implemented in |
|---|---|---|
| `GorgeFramework.Element`, `Note`, `Node`, `Sprite`, `CurveSprite`, all `*FunctionCurve`, `VariableFloat`, `Vector2`, `ColorArgb`, `PeriodConfig`, `Asset*` | `Assets/Resources/Native.zip/**/*.g` (`native class`) | C# in `cn.starbow.gorge.unity.dll`, namespace `Gorge.Native.GorgeFramework` |
| `Dremu.*` | `Packages/cn.starbow.gorge.sampleforms/Dremu/**/*.g` (also inside `Assets/Resources/Forms/Dremu.bytes`) | compiled by GorgeCompiler at load |
| `DeentyStoryboard.*` | `.../sampleforms/DeentyStoryboard/**/*.g` | same |
| `Deenty.*`, `Reincal.*` | `.../sampleforms/Deenty|Reincal/**` | same |

There is **no C# source** for `DremuMainLane` etc. — they are `.g` classes compiled
at runtime. `Element`, `Note`, `VariableFloat`, curves are C# (`native class`), and
their field lists are in `Native.zip` while their behaviour is IL-only (the `.g`
submodule with the managed sources was never checked out).

---

# D. Field / property system and curve math

## D.1 `VariableFloat`

```
native class VariableFloat {
    @Inject float baseValue;                         // default 0
    [auto defaultValue] @Inject<FunctionCurve^> FunctionCurve variationCurve;  // default null
    float EvaluateAdd(float curveTime);
    float EvaluateDoubleLerp(float curveTime, float min, float max);
}
```

IL:

```csharp
float EvaluateAdd(float t) {
    if (variationCurve == null) return baseValue;
    return baseValue + variationCurve.Evaluate(t);
}
```

`EvaluateDoubleLerp(t, min, max)` interpolates between `min` and `max` using the
curve as a 0..1 factor (used where a field means "progress", e.g. storyboard alpha /
positionZ). Semantics: `curve == null → baseValue`; otherwise
`lerp(min, max, curve.Evaluate(t))` clamped by the curve's own output.

So a `VariableFloat` is **"constant + curve"**: the field's value at time `t` is
`baseValue + curve(t)`. That is why practically every numeric property in a Dremu
chart is a `VariableFloat` and why the `information` strings say
"实时坐标为基值加上纵轴值" (real value = base + curve y).

## D.2 `CubicHermiteSpline` — exact math

```
native class CubicHermiteSpline : FunctionCurve {
    [auto defaultValue] @Inject<Vector2^> Vector2 startPoint;   // (x, y)
    [auto defaultValue] @Inject float startTangent;             // dy/dx at start
    [auto defaultValue] @Inject float startWeight;              // 0..1, clamped
    [auto defaultValue] @Inject<Vector2^> Vector2 endPoint;
    [auto defaultValue] @Inject float endTangent;
    [auto defaultValue] @Inject float endWeight;
    float Evaluate(float x);
}
```

`Evaluate` (IL, complete):

```csharp
float Evaluate(float x) {
    if (x < startPoint.x) return startPoint.y;
    if (x > endPoint.x) return endPoint.y;
    return (float)AnimationCurveInterpolant(
        startPoint.x, startPoint.y, startTangent, Mathf.Clamp01(startWeight),
        endPoint.x,   endPoint.y,   endTangent,   Mathf.Clamp01(endWeight),
        x);
}
```

i.e. **clamped at both ends** (flat continuation, no extrapolation).

`AnimationCurveInterpolant` is Unity's weighted-tangent cubic (the same solver
`AnimationCurve` uses for keyframes with in/out weights). In normalized form, with
`dx = x2-x1`, `dy = y2-y1`, `t = (x-x1)/dx`, `m1 = yp1*dx/dy`, `m2 = yp2*dx/dy`,
`w1 = clamp01(wt1)`, `w2 = clamp01(wt2)`:

* if `w1 == 1/3 && w2 == 1/3` → plain cubic Hermite with parameter `t`:
  `y = y1 + dy * ( 3(1-t)²t·m1 + 3(1-t)t²·m2 + t³ )`  (IL takes this fast path);
* otherwise it solves (Newton, tolerance 4.44e-16) for the parameter `u` of the
  weighted curve and evaluates
  `y = y1 + dy * ( 3(1-u)²u·w1·m1 + 3(1-u)u²·(1 - w2·m2) + u³ )`.

Practical guidance for a generator:

* **Defaults** (from `InjectorFieldDefaultValue_*` in the DLL) are
  `startPoint (0,0)`, `startTangent 0`, `startWeight 1/3`,
  `endPoint (1,1)`, `endTangent 0`, `endWeight 1/3` — i.e. an identity ramp `y = x`
  on `[0,1]`. A literal that only says
  `endPoint : Vector2 : { x : 1.0, y : -3.5 }` is therefore a smooth S-curve from
  `(0,0)` to `(1,-3.5)` with horizontal-ish tangents (`Chart 2/DremuStaff.g`).
* Tangents are **slopes in chart units** (dy/dx), not angles: `startTangent : -80.0`
  with a 1.05 s span and a 3.2-unit y-span is a near-vertical launch.
* Weights are 0..1 and are silently clamped. `0.0` = "tangent ignored",
  `1/3` = "classic Hermite", `1.0` = "full Unity-style weighting".
* Real Dremu art lines use `startWeight 0.035 / endWeight 0.0` to get an almost
  vertical take-off that eases into a straight line
  (`DremuStaff.g:22-33`).
* `startPoint.x`/`endPoint.x` are **times** (seconds since `generateTime` for
  `drawStartX`), *not* normalized — they must be ordered and should span the
  element's visible window.
* If `startPoint.x == endPoint.x` or `y1 == y2`, `m1`/`m2` divide by zero; Unity's
  solver degenerates to a constant. Avoid zero-length x spans.

## D.3 Colour curves

```
native class ColorCurve { injector ColorCurve(); ColorArgb Evaluate(float x); }

native class LerpColorCurve : ColorCurve {
    [auto defaultValue] @Inject<ColorArgb^[]^> ColorArgb[] colorPoints;   // gradient stops
    [auto defaultValue] @Inject<FunctionCurve^> FunctionCurve progressCurve; // 0 = stop 0
    ColorArgb Evaluate(float x);
}
```

Evaluation (IL): if `colorPoints` is null or empty → `Color.white`. If
`progressCurve` is null → the **first** stop (or white). Otherwise
`p = progressCurve.Evaluate(x)`, `i1 = Clamp(FloorToInt(p), 0, n-1)`,
`i2 = Clamp(CeilToInt(p), 0, n-1)`, and the result is the component-wise lerp
between stop `i1` and stop `i2` by `p - i1`. Stops are *not* re-sorted and there is
no automatic spacing — index `i` corresponds to progress `i`, so N stops span
progress `[0, N-1]`.

Observed idiom (fade-in on notes):

```
color : GorgeFramework.LerpColorCurve : {
    colorPoints : GorgeFramework.ColorArgb^ : {
        GorgeFramework.ColorArgb : { a : 0.0, r : 0.0196078, g : 0.7607843, b : 0.5882353, },
        GorgeFramework.ColorArgb : { a : 1.0, r : 0.0196078, g : 0.7607843, b : 0.5882353, },
    },
    progressCurve : GorgeFramework.LinearCurve : {
        timeStart : -0.6,
        timeEnd : -0.3,
    },
},
```

i.e. two stops (transparent → opaque, same RGB) and a `LinearCurve` mapping
`t ∈ [-0.6, -0.3]` (relative to hit time) onto progress 0→1. `ColorArgb`'s field
defaults are **all 1.0**, so a `ColorArgb` literal that omits `a` is fully opaque.

## D.4 Curve family — evaluation summary

| Type | `Evaluate(x)` |
|---|---|
| `ConstantFunctionCurve` | `value` |
| `LinearFunctionCurve` | `k*x + b` |
| `QuadraticFunctionCurve` | `a*x*x + b*x + c` |
| `CubicHermiteSpline` | D.2 |
| `PiecewiseFunctionCurve` | first piece whose `[startX,endX]` contains `x` (inclusive flags `leftClosed`/`rightClosed`), else `0`; `null` pieces / null list → `0` |
| `CompositeFunctionCurve` | `outer.Evaluate(inner.Evaluate(x))`; any null → `0` |
| `PeriodicFunctionCurve` | `p = endX-startX; x' = (x-startX) % p + startX` (then `leftClosed` decides the boundary), `functionCurve.Evaluate(x')` |
| `AxialSymmetricFunctionCurve` | `keepLeft ? (x <= axis ? f(x) : f(2*axis - x)) : (x >= axis ? f(x) : f(2*axis - x))` |
| `AdditionFunctionCurve` | `f1(x) + f2(x)` |
| `MultiplicationFunctionCurve` | `f1(x) * f2(x)` |
| `ArcFunctionCurve` | circular arc spanning chord `[chordStart, chordEnd]` with central angle `angle` (radians) |
| `LinearCurve` | Unity `AnimationCurve.Evaluate(x)` built from `(timeStart,valueStart)`/`(timeEnd,valueEnd)` |

## D.5 Time model (the part that bites)

Definitions, all in **seconds**, all `float`:

| Symbol | Where | Meaning |
|---|---|---|
| `timeOffset` | `PeriodConfig` | period-local → global shift. Audio: absolute start of the audio. Element: added to specific fields by the form's `@PeriodModifier`. Default `0.0`. |
| `minLength` | `PeriodConfig` | editor only: minimum width of the period block on the timeline (seconds). Default `10.0`. Does **not** affect playback. |
| `generateTime` | `DremuLane` | element appears (period-local) |
| `keepTime` | `DremuLane` | element lifetime |
| `hitTime`, `leadTime`, `lagTime` | `DremuNote` | hit moment, spawn lead, destroy lag |
| `holdTime` | `DremuHold` | hold length |
| `startMoment` | `StoryboardEntity` | appear time (the storyboard's `generateTime`) |
| `generateTime` (engine) | `TimedGenerateElement` | *computed* from the `@ForwardTimedGenerate`/`@BackwardTimedGenerate` delegate, not stored |

Relations:

```
global chart time          = period.timeOffset + local field value
DremuLane     visible      = [generateTime, generateTime + keepTime]
DremuMainLane visible      = [generateTime, generateTime + keepTime]
DremuNote     spawn        = hitTime - leadTime
DremuNote     destroy      = hitTime + lagTime
DremuHold     destroy      = hitTime + holdTime + lagTime
Storyboard    visible      = [startMoment, startMoment + keepTime]
Audio         playing      = [timeOffset, timeOffset + clip.length)
```

`@PeriodModifier` is applied **once, at load**, when the injector is added to the
`ChartManager` (`ChartManager.AddScoreElement(inj, cfg)` → `Modify(...)` records
`InjectorModifications[original] = modified`). The `.g` file therefore always stores
*period-local* times; the runtime works with *global* times. Dremu implements it as:

```
// DremuMainLane.g / DremuGuideLane.g
@PeriodModifier static void PeriodModifier(DremuLane^ inj, PeriodConfig cfg)
    => inj.^generateTime += cfg.timeOffset;

// DremuNote.g
@PeriodModifier static void PeriodModifier(DremuNote^ inj, PeriodConfig cfg)
    => inj.^hitTime += cfg.timeOffset;

// DeentyStoryboard/Image.g
@PeriodModifier static void PeriodModifier(Image^ inj, PeriodConfig cfg)
    => inj.^startMoment += cfg.timeOffset;
```

The global window of the whole score is `SimulationScore.StartTime` /
`TerminateTime`, passed into the constructor by the runtime (the editor uses it to
lay out the timeline; `-1` and `1` in `RuntimeManager`'s "empty" path).

---

# E. Common base fields — the exact answer

**There is no `alpha`/`layer`/`positionZ` on the framework base.** The precise split:

| Level | Fields | Where declared |
|---|---|---|
| Framework `Element` (native, C#) | `simulator`, `lateIndependentSimulator`, `nodes` | `Native.zip/Element.g` |
| Framework `Note : Element` | `automaton` + `DoRespond(...)` | `Native.zip/Note.g` |
| **Dremu form base** `DremuLane : Element` | `name`, `generateTime`, `keepTime`, `laneLines`, `animation`, `drawStartX`, `drawEndX`, `pointCount`, `evaluateDelta`, `color`, `positionZ` | `Dremu/Lane/DremuLane.g` |
| `DremuMainLane : DremuLane` | `positionX`, `positionY`, `rotationZ` | `Dremu/Lane/DremuMainLane.g` |
| `DremuGuideLane : DremuLane` | `mainLaneName`, `position`, `targetProjectionFix` | `Dremu/Lane/DremuGuideLane.g` |
| **Dremu note base** `DremuNote : Note` | `laneName`, `hitTime`, `leadTime`, `lagTime`, `position`, `distance`, `color`, `hintReference`, `respondHintColor1/2`, `positionZ` | `Dremu/Note/DremuNote.g` |
| **Storyboard base** `StoryboardEntity : Element` | `assetName`, `startMoment`, `keepTime`, `positionMode`, `positionX/Y`, `rotationZ`, `scaleX/Y`, `positionZ`, `alpha`, `useChartTime` | `DeentyStoryboard/Image/StoryboardEntity.g` |

So:

* `color` and `positionZ` are declared **twice** — once in `DremuLane` and once in
  `DremuNote` (they are *not* shared through `Element`), which is why lanes default
  to `positionZ -1` and notes to `-2`.
* `name` / `generateTime` / `keepTime` are **lane-only**. Notes have `laneName` /
  `hitTime` instead and no "generate time" field of their own (their window is
  derived from `hitTime ± leadTime/lagTime`).
* `startMoment` exists **only** on storyboard elements; `alpha` only on storyboard
  elements; `hitTime` only on notes.
* `easing` does not exist as a field at all. Easing is expressed either by the
  curve type (`CubicHermiteSpline` for custom tangents) or by
  `LinearCurve`'s Unity `AnimationCurve` (whose tangents the editor does not expose).
* The editor does **not** hard-code any of these names; it renders whatever
  `@Inject` fields the class declares, grouped by the `type` metadata. Ordering,
  labels, tooltips and validation all come from the `.g` metadata (B.4).

---

# F. The `chartstudio` editor

## F.1 Architecture

Entry point `GorgeEditor.EditorManager : MonoBehaviour`
(`.../chartstudio/Runtime/Scripts/GorgeEditor/EditorManager.cs`), wired from a scene
with prefabs under `Resources/gorgeEditor/prefab/**`.

```
EditorManager (Awake)
├─ Base.Instance = new UnityBase(gameplayPanel, renderBase)
├─ InitEditor()
│   ├─ EditorExecutor           undo/redo stacks (IEditAction, limit 200)
│   ├─ SelectionManager         element / period / staff selection
│   ├─ TopBarManager            load / save / save-as / assets / settings
│   ├─ AssetListEditorManager   asset list UI
│   ├─ SimulationManager        playback buttons + 2 timeline sliders
│   └─ EditorServer(14324)      JSON-RPC, controllers registered here
├─ Forms = [GorgeCommonLib, DeentyStoryboard, Dremu]  (Package.LoadFolderPackage)
└─ LoadChart(Package.LoadZipPackage("./DremuTest.zip", true))
    ├─ RuntimeManager.CreateLanguageRuntime(packages)  → compile all .g
    ├─ PrepareFormEditor()   EditorFormContainer, ListEditorManager, PianoRollManager,
    │                        ScoreEditorManager, FieldEditorManager
    ├─ Runtime.ExtractSimulationResources()  (assets, audio)
    └─ CreateChartEditor()   ScoreEditorManager.LoadScore(); SimulationManager.LoadScore();
                             Runtime.CreateSimulationRuntime()
```

`Update()` pumps `Server.ProcessMainThreadActions()` (the HTTP server runs on a
background thread and marshals every call onto Unity's main thread) and binds
Ctrl+Z / Ctrl+Shift+Z.

Key data model (framework, `Gorge.GorgeFramework.Chart`):

```
SimulationScore
├─ Stave : List<IStaff>            ElementStaff | AudioStaff
│    └─ Periods : List<IPeriod>    ElementPeriod | AudioPeriod
│         ├─ MethodName : string            ("Period", "Period1", …)
│         ├─ Config : PeriodConfig          (timeOffset, minLength)
│         ├─ ConfigInjector : Injector      (source of truth for serialisation)
│         └─ Elements : List<Injector>      (ElementPeriod only)
├─ AssetLoaders : List<AssetLoader>         ("AutoLoaded")
├─ ChartAssetFiles : List<AssetFile>
└─ StartTime / TerminateTime / SimulationSpeed
```

`ExtractStaveFromRuntime` (IL) is the loader: it walks every `GorgeClass`, and

* `@AudioStaff` → `new AudioStaff(name, true, displayName?)`, then for every
  **static** method with `@Song`: read metadata `config` (throws if absent), invoke
  it to get the `AudioAsset` injector, `new AudioPeriod(methodName, config, audio)`;
* else `@ElementStaff` → `new ElementStaff(name, true, displayName?, form?)`
  (`form` required), then for every static method with `@Chart`: read `config`
  (required), invoke it, cast the resulting `ObjectArray` items to `Injector`,
  append to the `ElementPeriod`.

## F.2 UX

The editor is a full-screen tool, roughly:

```
┌ TopBar: 加载 | 保存 | 另存为 | 资源编辑 | 编辑器设置 ────────────────────┐
├ staff name column │ staff track (period blocks on a shared time axis) ──┤
│ DremuStaff        │ ▓▓▓▓▓▓ Period (timeOffset 1.0)                      │
│ DremuStaff1       │ ▓ Period ▓ Period1 ▓ Period2 …                      │
│ Song              │ ▓ audio                                             │
├ element list (right/bottom panel) ──────────────────────────────────────┤
│ [Add▾][Duplicate][Remove][Copy][Paste]  … list of elements with colour  │
├ injector inspector (right): grouped fields, curve editors, check marks   │
├ monitor: ▶ ⏸ ⟲ start/stop + timeline slider + playhead                  │
└ piano roll (toggled): per-element-type tracks (Dremu has none)          │
```

* **Staff track** — one row per staff; each period is a block anchored by
  `[timeOffset, timeOffset + max(contentLength, minLength)]` and normalised over
  `[Score.StartTime, Score.TerminateTime]` (`PeriodEditorBase.UpdateConfig`).
  Drag a block → `timeOffset += delta` via `PeriodConfigEditAction`; the whole
  period's elements move with it (because `@PeriodModifier` shifts them at load).
  Right-click → rename method / copy period / edit config. Double-click → open the
  piano roll for that period.
* **Element list** — per selected period; each row shows the element's `display`
  delegate result (e.g. `"ArtLine1"` for lanes, `"5.052631"` for notes), its `color`
  swatch, and a mini `elementLine` bar. Tools: Add (element type palette, grouped by
  `@EditableElement.type`), Duplicate, Remove, Copy/Paste (in-memory), "TempEdit",
  "TempChangeType".
* **Injector inspector** — reflects the selected element's `@Inject` fields, grouped
  by the `type` metadata and sorted by `order`. Each field renders according to its
  type: float slider/box, int, bool toggle, string, enum dropdown, `ColorArgb`
  colour picker, `VariableFloat` (a `baseValue` box plus a curve editor),
  `FunctionCurve` (curve editor dialog with a live plot), `ColorCurve` (gradient
  dialog), object lists (`innerNotes`), nested injectors (recursive panel).
  A "default" toggle per field mirrors `Injector.Get...Default`; `allowDefault` is
  exposed over the API.
* **Curve editors** — `FloatingWidget/Window/FunctionCurveDialogWindow.cs` and
  `ColorCurveDialogWindow.cs`, with rendering in `CurveRenderer.cs` /
  `ColorCurveRenderer.cs`; the curve is picked from a type dropdown
  (`TypeSelectableInjectorEditor`), then its fields edited in a sub-panel.
* **Simulation / monitor** — `SimulationManager` implements `ISimulationDriver`:
  Play / Pause / Replay / Start / Stop, two `TimelineSlider`s (monitor + track) that
  call `SimulationMachine.SimulateTo(value)` on drag. Element edits trigger a
  strategy chosen by `@EditableElement(editUpdateMode=…)`: `Static` (nothing),
  `ReInject` (call `@EditReInject` then `DriveInstantly`), `ReGenerate`, `RePlay`
  (rebuild the simulation and fast-forward) — `ChartManagerEditor` +
  `ElementPeriodExtension.GetEditUpdateMode` (RePlay wins over ReGenerate over
  ReInject over Static).
* **Piano roll** — `PianoRollManager` builds one track per element class that
  declares a `@PianoRollPoint` static method. **None of the Dremu types do** (only
  `Deenty.Tap` does), so opening the piano roll on a Dremu period yields no tracks;
  note editing happens in the element list instead.
* **Save** — `RuntimeStatic.Runtime.Score.ExportChartPackage().SaveZipPackage(path)`
  (A.1). Undo/redo does not touch disk; there is no autosave.

## F.3 Edit actions (undoable commands)

`.../GorgeEditor/EditAction/` — every mutation is an `IEditAction`
(`Do()` / `Undo()`), executed through `EditorExecutor` (undo stack, redo stack,
limit 200):

| Action | Effect |
|---|---|
| `ElementInsertAction` | `period.Elements.Insert(index, inj)`; `Chart.AddElement(inj, period.Config, mode)`; refresh list + track |
| `ElementRemoveAction` | inverse |
| `ElementEditAction` | replace an injector (old→new), re-render, optional `ReInject` |
| `PeriodInsertAction` / `PeriodRemoveAction` | add/remove a `@Chart` method + block |
| `PeriodConfigEditAction` | change `timeOffset`/`minLength`, refresh all elements of the period |
| `PeriodMethodNameEditAction` | rename the method (serialised as the method identifier) |
| `StaffInserttAction` / `StaffRemovetAction` / `StaffClassnameEditAction` / `StaffDisplayNameEditAction` | staff-level CRUD |
| `AudioEditAction` | audio staff/period changes |

Note that the in-memory model is authoritative while editing; the `.g` text is
produced only on export (`ToGorgeCode`), so an external tool that edits `.g` files
must re-load the package to see them.

## F.4 HTTP API (the reusable part)

`EditorServer` is a **JSON-RPC 2.0-ish** server (not REST): one POST endpoint, one
method per call, JSON in / JSON out, HTTP 200 always.

* Listens on `http://localhost:14324/` **and** `http://127.0.0.1:14324/`
  (`EditorManager.InitEditor`: `new EditorServer(14324)`).
* Registered controllers: `ScoreInformationController`, `ScoreActionController`,
  `AssetController` (`Server.RegisterController(new …())`).
* Method name = `[EditorAPI("name")]` or, if omitted, the C# method name with a
  lowercased first letter.
* Calls are marshalled to Unity's main thread and the HTTP thread blocks until the
  call finishes (10 ms poll) — so the call is synchronous from the client's view.

### Request / response

```http
POST / HTTP/1.1
Host: 127.0.0.1:14324
Content-Type: application/json

{"method":"getScoreInformation","params":{},"id":"1"}
```

```json
{"result":{ ... },"error":null,"id":"1"}
```

* `params` may be an **object** (named arguments, missing ones fall back to the
  parameter default) or an **array** (positional).
* Response is always `{"result":…,"error":…,"id":…}`; `error` is `null` on success.
* Error codes: `-32700` invalid JSON, `-32601` unknown method, `-32602` bad
  parameters, `-32603` no implementation instance / exception thrown inside the
  method (with `data.stackTrace`).

### Method surface

| Method | Params | Returns |
|---|---|---|
| `getScoreInformation` | — | `{staves:[{name, displayName, form, periods:[{name, timeOffset}]}]}` |
| `getPeriodElements` | `staffName`, `periodName` | `[{className}]` (order = `Elements` order = file order) |
| `getPeriodAudioDetails` | `staffName`, `periodName` | `string` (the audio injector's `ToDisplayString()`) |
| `getElementDetails` | `staffName`, `periodName`, `elementIndex` | `string` (the injector's `ToDisplayString()`) |
| `getEditableElementInformation` | — | `[{className, displayName, type, fields:[{fieldType, fieldName, displayName, description, allowDefault}]}]` |
| `getEditableTypeInformation` | `className` | `[{className, displayName, fields:[…]}]` — subclasses of `className` carrying `@Editable` |
| `addPeriod` | `staffName`, `periodName`, **`timeOffset` (int!)** | status string |
| `removePeriod` | `staffName`, `periodName` | status string |
| `addSimpleTapNote` | `staffName`, `periodName`, `insertIndex`, `laneName`, `hitTime`, `position` | status string |
| `addSimpleTaplikNote` | same | status string |
| `addSimpleDragNote` | same | status string |
| `addSimpleHoldNote` | same + `holdTime` | status string |
| `addElement` | `staffName`, `periodName`, `insertIndex`, `injectorString` | status string |
| `removeElement` | `staffName`, `periodName`, `removeIndex` | status string |
| `predictRhythm` | `staffName`, `periodName` (must be an `AudioStaff`) | `float[]` onsets, via a Gradio server at `http://127.0.0.1:7860/api/predict` |

Notes:

* `addElement` compiles the given literal at runtime:
  `EditorStatic.Editor.CompileContext.DynamicCompileObjectInjector(injectorString)`
  — which parses the string as **one `expression()` and asserts it is an object
  literal** (`ExpressionExtension.Assert<ObjectImmediate>`), then returns its
  constant `Injector`. This is the **most general write primitive** — pass a full
  object literal such as
  `"Dremu.DremuTap : { laneName : \"Main1\", hitTime : 12.0, }"`.
  Statements, class bodies or bare field lists are rejected.
* The four `addSimple*Note` helpers build the injector themselves
  (`GenerateDefault()`, then `SetInjectorFloat/Object/String`) and only set
  `hitTime`, `position.baseValue`, `laneName` (+ `holdTime`). Everything else keeps
  the class default.
* `addPeriod` takes an `int timeOffset` — a bug/limitation: fractional offsets are
  truncated. Use `addElement`-style literal editing or a direct file edit for
  fractional periods.
* There is no "edit element" endpoint: `EditElement` exists but is **not** decorated
  with `[EditorAPI]`, hence unreachable. To change an element over HTTP, remove and
  re-add (`removeElement` + `addElement` at the same index).
* There is no save endpoint. Saving is a UI action.
* `className` values are **fully qualified** (`"Dremu.DremuTap"`), while
  `staffName`/`periodName` are the class name and the method name (`"DremuStaff1"`,
  `"Period3"`).

### Example session

```bash
curl -s http://127.0.0.1:14324/ -d '{"method":"getScoreInformation","params":{},"id":1}'
curl -s http://127.0.0.1:14324/ -d '{"method":"getPeriodElements",
  "params":{"staffName":"DremuStaff1","periodName":"Period3"},"id":2}'
curl -s http://127.0.0.1:14324/ -d '{"method":"addElement",
  "params":{"staffName":"DremuStaff1","periodName":"Period3","insertIndex":0,
            "injectorString":"Dremu.DremuTap : { laneName : \"Main1\", hitTime : 12.0, }"},
  "id":3}'
```

---

# G. Semantics for editing a Dremu chart

## G.1 Timebase: raw seconds, quantised to 1/19 s

Charts do **not** store BPM. Every time value is a `float` in seconds, and the
editor's BPM/offset/`beatPerBar`/`subBeatPerBeat` are **UI-only** helpers
(`EditorManager.bpm` default 120, `TryParseBeatString("123:45.678")` parses
`bar:beat.subbeat` for the time entry boxes). The `.g` file never contains a tempo.

Empirically, every time value in `DremuTest` is an integer multiple of

```
q = 0.0526316 s = 1/19 s
```

(checked: all 229 **distinct** `hitTime` values across `DremuStaff1.g` +
`DremuStaff2.g` were exact multiples of `q`; `generateTime` values follow the same
grid). The most common deltas are `0.105263` (2q), `0.210526` (4q), `0.31579` (6q),
`0.63158` (12q).

Why 1/19 s? Because the song is ~190 BPM:

* audio onset autocorrelation on `Song.wav` peaks at **191.4 BPM** (±0.7 %);
* `1 bar` of the chart's art-line cycle is `2.526316 s`, and
  `60/95*4 = 2.5263157…` → exactly **1 bar at 95 BPM in 4/4**, or **2 bars at 190 BPM**;
* `q = (60/190)/6 = 0.0526316` → the grid is **1/6 of the 190-BPM pulse** =
  1/12 of a 95-BPM beat = a 24th-note grid (16th-note sextuplet);
* `1.263158 s = 60/95*2` (2 beats @95 / 1 bar @190), `23.47368 s = 37 + 1/6 beats @95`.

Practical rule for a generator: use **95 or 190 BPM** as the musical reference and
snap everything to `k/19` seconds. Do not write arbitrary decimals — it will parse,
but the editor's grid and every future edit will drift.

Other fixed points:

* `Song.g` `timeOffset = 0.373` → the audio starts at chart time 0.373 s. Chart
  times are therefore `audioSeconds + 0.373`.
* Total audio 130.75 s; the chart's last events are ~107 s (DremuStaff1) and
  ~95 s absolute (DremuStaff2, offsets up to 84.37 + content).

## G.2 What a lane is, and how notes attach

* `Dremu.DremuMainLane` = a judgement line: a curve `y = f(x)` over
  `x ∈ [drawStartX(t), drawEndX(t)]`, moved by `positionX/Y(t)`, rotated by
  `rotationZ(t)`, drawn with `color(t)`, sorted by `positionZ`.
  It has a `name` (`"ArtLine1"`, `"Main1"`, `"Main2L"`, …).
* `Dremu.DremuGuideLane` = a secondary line that rides on a main lane
  (`mainLaneName`) and is offset along the main line's normal by `position(t)`.
* A note picks its lane **by name**: `laneName : "Main2L"`. Lookup order is
  `Dremu.DremuMainLane` then `Dremu.DremuGuideLane`, among *alive* lanes
  (`Environment.FindAliveLane`), evaluated in the note's constructor. Consequences:
  the lane must exist **and be alive at the note's spawn time**
  (`hitTime - leadTime`), so the lane's `generateTime/keepTime` window has to cover
  every note that references it. Lane names are resolved against the whole loaded
  score, so keep them unique among periods that overlap in time.
* Note geometry inside a lane: `position` = lateral offset (evaluated at
  `t = now - hitTime`, then mapped through the lane's shape/normal), `distance` =
  offset from the judgement line — with the default `distance : LinearFunctionCurve
  : { k : -8.0 }` it is positive before the hit and reaches 0 exactly at `hitTime`,
  i.e. the note flies in and lands on the line.
* Draw order (defaults): lanes `positionZ -1`, notes `-2` (in front), storyboard
  images `+1` (behind). Smaller = closer to the camera.

## G.3 What a period is for

A period is a *batch of elements that share one `timeOffset` and are re-serialised
together*. Authors use them as:

* **chunks** — `DremuStaff1` has 20 periods, roughly one per section, so the editor
  stays responsive and a drag of the block moves the whole section;
* **layers** — several periods can overlap in time to separate background art
  (`DremuStaff.g`), main notes (`DremuStaff1`), and guide-lane decoration
  (`DremuStaff2`);
* **parallel timelines** — `DremuStaff2`'s out-of-order offsets (11.1, 12.4, 13.6,
  14.9, 19.9, 18.7, 17.4, 16.2, 28.8, 59.1, 84.4) show periods are independent and
  need not be sorted.

Because `timeOffset` is folded into `hitTime`/`generateTime`/`startMoment` at load,
moving a period is a single-number edit that shifts all its content — and a
generator can always emit everything with `timeOffset : 0.0` and absolute times
(legal, and what the older hand-written charts do).

## G.4 Recipes

**New chart, minimal** (2 lanes + 3 notes, 10 s):

```
[
    string form = "Dremu",
    string displayName = "MyStaff"
]
@ElementStaff
class MyStaff
{
    [
        GorgeFramework.PeriodConfig^ config = GorgeFramework.PeriodConfig : {
            timeOffset : 0.0,
        }
    ]
    @Chart
    static GorgeFramework.Element^[] Period()
    {
        return new GorgeFramework.Element^[5]{
            Dremu.DremuMainLane : {
                name : "Main1",
                generateTime : 0.0,
                keepTime : 10.0,
            },
            Dremu.DremuMainLane : {
                name : "Main2",
                generateTime : 0.0,
                keepTime : 10.0,
                positionY : GorgeFramework.VariableFloat : {
                    baseValue : 3.0,
                },
            },
            Dremu.DremuTap : {
                laneName : "Main1",
                hitTime : 1.0,
            },
            Dremu.DremuTap : {
                laneName : "Main2",
                hitTime : 2.0,
            },
            Dremu.DremuHold : {
                laneName : "Main1",
                hitTime : 4.0,
                holdTime : 1.052632,
            },
        };
    }
}
```

Added to a package with a `Song.g` whose `wavFilePath` points at a file in the same
folder, this is a complete, loadable chart.

**Add a note to an existing period** — append one more `Dremu.DremuTap : { … },`
inside the period's array and bump the `new GorgeFramework.Element^[N]{` count.
(`N` must match; see H.)

**Change a lane's motion** — edit `positionY`/`rotationZ` (curves of *time since
`generateTime`*) or `laneLines`/`animation` (shape + morph index). To keep the same
shape and only move the line, touch `positionX`/`positionY` only.

**Move a section in time** — change the period's `config.timeOffset`; never rewrite
every `hitTime`.

**Add a storyboard image** — use the `DeentyStoryboard` form in its own staff:

```
DeentyStoryboard.Image : {
    assetName : "image:Background1",
    keepTime : 22.73684,
    positionMode : DeentyStoryboard.ImagePositionMode.ScreenCover,
    positionZ : 1.0,
},
```

with `Background1.png` in the package root.

---

# H. Gotchas, quirks and a validation checklist

## Formatting / emission

1. **Indent with 4 spaces.** The editor's writer uses exactly `"    "` per level;
   tabs parse but produce noisy diffs.
2. **Trailing commas everywhere** — after every field in an object literal and after
   every array item (including the last). The grammar makes them optional; the
   editor always writes them.
3. **Field order** = declaration order (base class first). Any order parses (the
   injector is keyed by field name), but only declaration order is diff-stable.
4. **Omit default-valued fields** to match editor output. A field written with its
   default value is semantically identical (`GetInjector…Default` is a flag, not a
   value comparison — the editor sets the flag when the UI value equals the
   default), so both forms work, but omission is what the editor emits.
5. **Floats always carry a decimal point** (`0.0`, not `0`). `0` is an `IntLiteral`;
   assigning it to a float field is a type error in a strict reader. Ints
   (`pointCount : 200`) must *not* get a `.0`.
6. **No exponent, no sign, no leading/trailing dot** in numeric literals; `-1.0` is
   unary minus applied to `1.0`.
7. **Strings**: only `\"`, `\\`, `\n`, `\r` escapes; no tab escape, no raw newline,
   no `\uXXXX`. CJK is fine (UTF-8). BOM is tolerated.
8. **Line endings** are platform-dependent on export (CRLF on Windows, LF on macOS).
   Both parse; pick one and be consistent.
9. **`new GorgeFramework.Element^[N]{…}` — `N` must equal the number of items.**
   It is the array length passed to `newarr`; a mismatch is a runtime/compile
   problem, not a recoverable one. (Grep-able invariant for any codec.)
10. **Empty arrays**: `new Element^[0]{ , };` (`{ , }` is the empty-array literal,
    not `{ }`). Empty objects: `Type : { : }`.
11. File should end with a newline after the staff's closing `}` (the writer does
    `AppendLine("}")`, so the last byte is `\n`).

## Structural requirements

12. A staff class **must** carry `@ElementStaff` or `@AudioStaff`. No annotation →
    not a staff (it compiles, and is silently ignored by the chart loader).
    `@AudioStaff` is tested first, so if a class somehow has both it becomes an
    audio staff.
13. `@ElementStaff` **requires** metadata `form`; `@Chart` and `@Song` **require**
    metadata `config`. Missing → exception at load ("谱表未指定模态" / config missing).
14. The `form` name must be registered (`@Form(name = "Dremu", …)` +
    `ElementTypeList()`), or the editor cannot resolve types for that staff.
15. `@Chart` methods must be `static`, take no parameters, and return
    `GorgeFramework.Element^[]`. `@Song` must be `static`, no parameters, returning
    `GorgeFramework.AudioAsset^`. Non-static methods are skipped silently.
16. Every element item must be an **injector** (`Type : { … }`). A raw object
    (`new X()`) in the array fails the `Injector` cast at load.
17. Class names must be unique across the whole project (all `.g` files are compiled
    as one unit). A duplicate `class DremuStaff` in two files is a compile error.
18. Period method names must be unique **within a staff** (they are the map key in
    `TryGetPeriod`); across staffs they may repeat (`Period` exists in every staff).
19. Element type names in a chart must be in the form's `ElementTypeList()`
    (`Dremu.DremuTap`, …). Using an unlisted class parses but breaks the editor.
20. Asset references (`image:…`, `audio:…`) resolve by *file name without
    extension* in the package root; a missing asset produces a null-deref inside the
    element constructor, not a friendly error.

## Semantic traps

21. **Times are period-local.** If you copy elements between periods, re-apply the
    delta yourself: the file value is *not* the global time.
22. **`timeOffset` is applied by the form, not the engine.** Only fields the form's
    `@PeriodModifier` touches are shifted (`generateTime` for lanes, `hitTime` for
    notes, `startMoment` for storyboard images). A *new* field you invent will not
    be shifted unless you also add a modifier.
23. **Lane lifetime must cover its notes.** Notes resolve the lane at spawn time
    (`hitTime - leadTime`); if the lane isn't alive then, `lane` is null and the note
    constructor returns before creating nodes (silently invisible, and later
    `DoRespond`/`GetAimDistance` would null-deref).
24. **Lane names are (in practice) global per loaded score**, not per period.
    `Environment.FindAliveLane(typeName, laneName)` scans the live lanes and returns
    a match, so two overlapping periods defining `"Main1"` will bind notes to
    whichever lane is alive first — keep lane names unique across overlapping time.
25. **`startMoment` vs `generateTime`** — storyboard elements use the former,
    Dremu lanes the latter. Mixing them up silently does nothing (unknown field →
    compile error in a strict reader; in the editor the field simply isn't offered).
26. **No `alpha` on Dremu elements.** Note/lane transparency is expressed through
    `color` (`LerpColorCurve` with an `a : 0.0` stop), or for storyboard images
    through `alpha`.
27. **`positionZ` is per-element, not a layer system**: lanes default `-1`, notes
    `-2`, images `+1`; smaller = drawn in front.
28. **`distance` curves with positive `k`** move the note *away* over time; the
    idiom is `k : -8.0` (approach at 8 units/s) — see
    `DremuNote.g` `[auto defaultValue = LinearFunctionCurve : {k : -8.0, b : 0.0}]`.
29. **`holdTime` is not part of `keepTime`.** A hold's lifetime is
    `hitTime + holdTime + lagTime`; `leadTime`/`lagTime` default to 1.5 s and are
    frequently overridden to 0.6 in the shipped chart.
30. **Float32 round-trip.** Values are `float`, printed with 6 fractional digits
    (`0.0######`); 7 significant digits is the safe budget. `1.052632` is `20/19`
    truncated — don't "fix" it to `1.0526316`.
31. **`minLength` is cosmetic** (timeline block width). Setting it to `0.0` makes
    the period block zero-width but does not change playback.
32. **Element order inside a period matters for the editor only** (list order, and
    z-fighting ties); playback order comes from times. New elements go at the index
    you pass to `addElement` / `insertIndex`.
33. **The editor hard-codes `PeriodConfig` field index 0 as `timeOffset`**
    (`Period.ConfigInjector.GetInjectorFloat(0)` in `PeriodEditorBase` when dragging
    a block). Keep `timeOffset` as the *first* declared field of `PeriodConfig` in
    any custom form, or period dragging will corrupt `minLength` instead.
34. **`addPeriod` truncates `timeOffset` to an integer** (the C# parameter is `int`),
    so fractional period offsets must be produced by editing the file or by
    `addElement`-level operations.

## Validation checklist for a produced file

```
[ ] every .g parses: braces balanced, 4-space indent, trailing commas optional
[ ] class has @ElementStaff/@AudioStaff (and `form` / `displayName` metadata)
[ ] every @Chart has `[...]` metadata with `GorgeFramework.PeriodConfig^ config = …`
[ ] array length literal == number of elements in the block
[ ] every element type is listed in the form's ElementTypeList()
[ ] every required field present: lane name / generateTime / keepTime;
    note laneName / hitTime; image assetName / keepTime
[ ] laneName refers to a lane that is alive over [hitTime-leadTime, hitTime+lagTime]
[ ] asset names exist as files: <name>.png / .wav / .mp4 in the package root
[ ] float literals contain '.', int fields do not
[ ] no unknown field names (compile error otherwise)
[ ] times snapped to 1/19 s (0.0526316) if you want the editor grid to line up
```

---

# Appendix 1 — Annotated real file (DremuStaff.g, first element)

`/Users/daxingyi/Music/DremuTest/DremuStaff.g:1-40` (CRLF, UTF-8 no BOM):

```
[
    string form = "Dremu",            ← metadata of @ElementStaff: which form
    string displayName = "表演"        ← metadata: track label
]
@ElementStaff
class DremuStaff
{
    [
        GorgeFramework.PeriodConfig^ config = GorgeFramework.PeriodConfig : {
            timeOffset : 1.0,         ← whole period shifted +1.0 s
        }
    ]
    @Chart
    static GorgeFramework.Element^[] Period()
    {
        return new GorgeFramework.Element^[11]{      ← exactly 11 items follow
            Dremu.DremuMainLane : {
                name : "ArtLine1",
                generateTime : 0.0,
                keepTime : 1.052632,                 ← 20/19 s
                drawStartX : GorgeFramework.VariableFloat : {
                    baseValue : 0.0,
                    variationCurve : GorgeFramework.CubicHermiteSpline : {
                        startPoint : GorgeFramework.Vector2 : { x : 0.0, y : 1.6, },
                        startTangent : -80.0,
                        startWeight : 0.035,
                        endPoint : GorgeFramework.Vector2 : { x : 1.052632, y : -1.6, },
                        endTangent : 0.0,
                        endWeight : 0.0,
                    },
                },
                drawEndX : …,
                color : GorgeFramework.LerpColorCurve : {
                    colorPoints : GorgeFramework.ColorArgb^ : {
                        GorgeFramework.ColorArgb : { r : 0.0196078, g : 0.7607843, b : 0.5882353, },
                    },
                    progressCurve : null,
                },
            },
            …
```

(The excerpt collapses the nested `Vector2`/`ColorArgb` bodies for readability — the
real file always expands them one field per line, as in B.7 — and the `←` comments
are annotations for this document, **not** part of the file; `.g` comments use
`//`.)

# Appendix 2 — Field quick reference (Dremu)

| Element | Serializable fields (declaration order) |
|---|---|
| `Dremu.DremuMainLane` | `name, generateTime, keepTime, laneLines, animation, drawStartX, drawEndX, pointCount, evaluateDelta, color, positionZ, positionX, positionY, rotationZ` |
| `Dremu.DremuGuideLane` | `name, generateTime, keepTime, laneLines, animation, drawStartX, drawEndX, pointCount, evaluateDelta, color, positionZ, mainLaneName, position, targetProjectionFix` |
| `Dremu.DremuTap` | `laneName, hitTime, leadTime, lagTime, position, distance, color, hintReference, respondHintColor1, respondHintColor2, positionZ` |
| `Dremu.DremuDrag` | same as `DremuTap` |
| `Dremu.DremuTaplik` | same as `DremuTap` |
| `Dremu.DremuHold` | `laneName, hitTime, leadTime, lagTime, position, distance, color, hintReference, respondHintColor1, respondHintColor2, positionZ, holdTime, innerNotes, endDistance, holdLine, truncation, holdLength, pointCount, targetProjectionFix` |
| `Dremu.DremuHoldInnerNote` | `hitTime, audioEffect, respondHint` |
| `DeentyStoryboard.Image` | `assetName, startMoment, keepTime, positionMode, positionX, positionY, rotationZ, scaleX, scaleY, positionZ, alpha, useChartTime` |

# Appendix 3 — Glossary (editor UI ⇄ data)

| UI (zh) | Data |
|---|---|
| 谱表 / staff | one `@ElementStaff` / `@AudioStaff` class (one row) |
| 乐段 / period | one `@Chart` method + its `PeriodConfig` (one block) |
| 音频乐段 / audio period | one `@Song` method + its `PeriodConfig` (one audio clip on the chart timeline) |
| 元素 / element | one injector item inside a period's array |
| 模态 / form | a form package (`Dremu`, `DeentyStoryboard`, …) |
| 轨道 / lane | `DremuMainLane` / `DremuGuideLane` |
| 生成时刻 | `generateTime` |
| 保持时长 | `keepTime` |
| 打击时刻 | `hitTime` |
| 超前生成时间 / 滞后销毁时间 | `leadTime` / `lagTime` |
| 叠放次序 | `positionZ` |
| 判定线形状 | `laneLines` |
| 判定线动画进度 | `animation` |
| 绘制起点 / 终点 | `drawStartX` / `drawEndX` |
| 绘制精度 | `pointCount` |
| 估算邻域宽度 | `evaluateDelta` |
| 偏移量 (audio) | `PeriodConfig.timeOffset` on `@Song` |
