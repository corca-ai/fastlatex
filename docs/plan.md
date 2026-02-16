# Plan

Overleaf를 월등하게 이길 수 있는 LaTeX 편집/컴파일/프리뷰 컴포넌트. 독립 제품이 아니라 **호스트 제품에 임베드**되는 구조이므로, 계정/인증/클라우드 저장/협업은 호스트 책임이고, 이 컴포넌트는 아래 네 가지에 집중한다:

* **(A) 즉시 반응하는 뷰(프리뷰 파이프라인)**
* **(B) 정확도를 수렴시키는 권위 엔진(TeX)**
* **(C) 두 세계를 연결하는 의미/좌표 매핑**
* **(D) 패키지/리소스/보안/재현성**

다음은 **실제로 Overleaf보다 체감적으로 빨라질 가능성이 높은 설계**와 **Iteration 단위 실행 계획**

---

# Part I. 설계

## 1) 목표를 수치로 못 박기 (성공 조건)

### UX KPI (체감 성능)

* **Keystroke → 화면 변화(무언가라도)**: 30–80ms (P50), 150ms (P95)
* **Keystroke → "정확한 결과로 수렴"(권위 렌더)**: 300–1200ms (문서 크기에 따라)
* **PDF 클릭 → 소스 점프**: 50ms 이내
* **스크롤/줌 FPS**: 60fps 유지(대부분의 장면)
* **대형 문서(100p)**: "현재 페이지"는 200ms 내 업데이트, 전체는 비동기 수렴

이 수치가 나오려면 "매번 PDF 전체 재생성+재파싱"만으로는 어렵습니다. 그래서 아래 아키텍처가 필요합니다.

---

## 2) 아키텍처: "권위(TeX) + 실시간(렌더러) 분리"가 핵심

### 큰 그림

1. **권위 엔진(TeX)**는 정확도를 보장한다. (pdfTeX WASM 우선, 서버 fallback)
2. **실시간 뷰**는 즉시 반응한다. (canvas 최적화 → 장기 WebGPU)
3. **동기화(소스↔뷰)**는 SyncTeX + 엔진 트레이스로 한다. (pdfTeX C 코드 수정)

### 구성요소

* **Editor**: Monaco
* **Engine**: pdfTeX 1.40.22 WASM (SwiftLaTeX 기반, SyncTeX 포함 재빌드 완료)
* **Fallback Server**: full TeX Live (pdfTeX + XeTeX + LuaTeX) — WASM 한계 시 자동 전환
* **Two outputs** (장기)

  * (1) **PDF**: 최종/권위/내보내기
  * (2) **Page Display List (PDL)**: 실시간 프리뷰용 (pdfTeX shipout 훅)
* **Viewer**

  * **PDFView(PDF.js)**: 현재 기본 뷰어 (canvas pool, 가시 페이지 우선 렌더)
  * **LiveView(WebGPU)**: PDL 렌더 (장기 목표)
* **Package System**: whitelist + lockfile + CDN lazy fetch + 해시 검증

---

## 3) 엔진 결정: pdfTeX WASM (Tectonic 불채택)

### 결정 경위

I0에서 Tectonic(Rust, XeTeX 기반)과 SwiftLaTeX pdfTeX WASM을 비교 평가했다.

| 기준 | Tectonic | pdfTeX WASM |
|------|----------|-------------|
| WASM 빌드 가능성 | ~30% (ICU4C/harfbuzz/freetype 의존) | ✅ 검증 완료 |
| 바이너리 크기 | 예상 10-20MB+ (ICU 데이터 포함) | 1.6MB |
| 빌드 파이프라인 | 미검증 | ✅ 2-phase 빌드 확립 (I3) |
| C 코드 수정 능력 | Rust (깔끔하지만 미경험) | WEB-to-C (읽기 어렵지만 I3에서 검증) |
| Unicode/OpenType | ✅ 네이티브 (XeTeX 기반) | ❌ 8-bit 엔진 (inputenc/fontenc로 대부분 커버) |
| 학술 논문 호환성 | 높음 | 높음 (90%+ 논문은 pdfTeX로 충분) |

**결론: pdfTeX WASM 유지.** Tectonic의 유일한 실질적 장점(Unicode/OpenType)은 서버 fallback(full TeX Live)으로 커버한다.

### pdfTeX WASM을 선택한 이유

1. **검증된 파이프라인**: I3에서 pdfTeX C 코드 수정(SyncTeX 28개 심볼 rename) + Emscripten 재빌드에 성공. 같은 방식으로 엔진 레벨 최적화(preamble snapshot, yield point, PDL 출력)를 적용할 수 있다.
2. **작은 바이너리**: 1.6MB WASM. Tectonic은 ICU4C 데이터만으로 수 MB. 초기 로드 성능에 직접 영향.
3. **빌드 성공 확률**: Tectonic WASM 빌드는 63% C 의존성(ICU4C, harfbuzz, freetype)으로 실패 위험이 높다. 8-12주 투자 후 실패하면 전액 손실.
4. **이원 전략**: WASM(pdfTeX, 빠르고 가벼움)으로 90%+ 커버, 서버(full TeX Live: pdfTeX + XeTeX + LuaTeX)로 100% 커버. Tectonic 하나로 통일할 필요 없음.
5. **Tectonic의 Rust 장점은 코드 품질이지 사용자 가치가 아님**: 코드가 깔끔해지는 건 좋지만, 마이그레이션 비용을 정당화할 만큼의 사용자 체감 차이가 없다.

### pdfTeX WASM 커스터마이징 로드맵

이하 4가지는 모두 pdfTeX C 코드 수정 + Emscripten 재빌드로 구현 가능. I3의 빌드 파이프라인(`wasm-build/`)을 그대로 활용한다.

#### (1) Preamble snapshot (성능 레버) — ✅ I4에서 구현

* ~~Emscripten `Module.HEAP`를 `ArrayBuffer.slice()`로 통째로 저장~~ → `\dump` primitive 방식 채택
* preamble 처리 후 format 파일 생성 → body 편집 시 cached format 로드
* 효과: 반복 편집 시 컴파일 ~40% 단축

#### (2) Interruptible compilation

* `emscripten_sleep()`을 shipout / paragraph 종료 지점에 삽입
* Emscripten Asyncify 플래그로 빌드 (yield → resume 가능)
* Worker가 타임 버짓(10-20ms) 단위로 실행, 입력 시 협조적 취소
* 효과: 대형 문서에서도 UI 블로킹 없음

#### (3) PDL(Page Display List) 출력

* `ship_out()` 함수에 훅 추가 → glyph position + font info를 binary로 worker에 전달
* PDF 생성과 병행 (별도 출력 채널)
* 장기적으로 WebGPU 렌더러의 입력 데이터로 사용
* 효과: PDF.js 파싱/렌더 단계를 우회하여 즉시 화면 반영

#### (4) Semantic Trace — Phase 1 완료 (I5a 정적 LSP + I5b 해시 테이블 스캔)

* **Phase 1 완료**: pdfTeX 해시 테이블 스캔 — 컴파일 후 WASM 힙에서 모든 정의된 제어 시퀀스 추출 → LSP Tier 3 자동완성
* Phase 2 예정: 매크로 확장 시점에 구조화 이벤트 emit (label, ref, cite, section, include)
* C 레벨 훅 또는 TeX 매크로 레벨 모두 가능
* LSP의 "진실"을 정적 파서가 아닌 엔진 실행 트레이스로 구성
* 효과: Overleaf+일반 에디터 조합을 넘어서는 정확한 자동완성/진단

---

## 4) GPU/WebGPU는 어디에 쓰는 게 "효과가 큰가"

### (A) 가장 큰 효과: **렌더링**

* LiveView(WebGPU): PDL 렌더 → 스크롤/줌/페이지 교체가 매우 빠름
* PDF.js 커스터마이징: 장기적으로 WebGPU backend로 이관 가능

  * 텍스트: glyph atlas (SDF/MSDF)
  * 벡터: path tessellation 캐시
  * 이미지: GPU 텍스처 캐시
  * 뷰포트/타일링: 화면에 보이는 부분만 그리기

### (B) 타입세팅 계산 GPU 가속은 "연구 베팅"

Knuth–Plass line breaking 같은 DP는 GPU로도 가능하지만, 구현/디버깅 대비 이득이 불확실합니다.
현실적 우선순위는:

1. **WASM SIMD + 멀티스레드(SharedArrayBuffer)**로 폰트/레이아웃/로그 처리 최적화 (pdfTeX WASM에 적용)
2. GPU는 **그린 픽셀(렌더)**에 집중

---

## 5) WebSocket을 "fallback" 이상의 무기로 쓰는 방법

서버 fallback을 단순 "느리면 서버 컴파일"로 끝내지 말고:

* WebSocket 채널로 서버가

  * 구조화 diagnostics
  * semantic trace
  * synctex
  * (선택) PDL 또는 페이지 타일 이미지
    를 **스트리밍**합니다.

이렇게 하면:

* 브라우저 엔진이 실패/느릴 때도 UX는 동일하게 유지
* 장기적으로 협업/공유/리뷰 기능으로 확장 용이

---

## 6) 패키지/재현성(Startup 제품에서 매우 중요)

Whitelist 기반이면 "점진적 확장"을 제품적으로 운영 가능하게 만들어야 합니다.

### 제안: TeX용 lockfile + bundle registry

* 프로젝트에 `tex.lock`(개념적으로):

  * TeX bundle 버전(TeX Live 스냅샷 유사)
  * 허용 패키지 목록
  * 각 패키지 해시(또는 Merkle root)
* 브라우저는 필요한 패키지를 CDN에서 lazy fetch, 해시 검증 후 캐시
* 서버 fallback도 동일한 lock을 사용 → 결과 재현

이게 있으면:

* "내 컴퓨터/네 컴퓨터에서 결과가 다름" 문제를 크게 줄이고,
* 템플릿/학회 스타일 제공이 제품적으로 쉬워집니다.

---

## 7) 이 설계의 차별점

1. **PDF를 최종 산출물로 유지하면서도**, 편집 중에는 **PDL+WebGPU로 '즉시 반응'**을 만든다.
2. LSP의 정확도를 정적 분석에 맡기지 않고, **엔진 semantic trace로 끌어올린다.**
3. VM snapshot/interruptible compilation처럼, **pdfTeX WASM을 제품 요구에 맞게 엔진 레벨로 변형**한다. (I3에서 검증된 빌드 파이프라인 활용)
4. **이원 엔진 전략**: WASM(pdfTeX, 빠르고 가벼움)으로 90%+ 커버, 서버(full TeX Live)로 100% 커버. 사용자는 차이를 의식하지 않음.
5. WebSocket fallback을 단순 백업이 아니라 **협업/빌드팜으로 확장 가능한 코어**로 설계한다.
6. whitelist를 "기술 제한"이 아니라 **프로파일/락파일/재현성**으로 제품화한다.

---

# Part II. 완료된 Iteration

각 Iteration 종료마다 사용자가 체감하는 가치가 분명히 증가하도록 설계했다.

---

## Iteration 0 (2주) — 리스크 제거 스파이크 ✅

**사용자 가치:** 없음(내부)
**목표:** 이후 6개월의 성공 확률을 좌우하는 실험을 끝낸다.

### 엔진 결정 (리스크 스파이크 결과)

Tectonic WASM은 63% C 의존성(ICU4C/harfbuzz/freetype)으로 브라우저 WASM 빌드 성공 확률 ~30%.
**SwiftLaTeX PdfTeX WASM을 MVP 엔진으로 채택** → `TexEngine` 인터페이스로 추상화하여 교체 가능한 구조.

### 진행 상태

- [x] 엔진 후보 평가 (Tectonic vs SwiftLaTeX)
- [x] SwiftLaTeX WASM 바이너리 확보 (`SwiftLaTeX/SwiftLaTeX` GitHub releases v20022022)
- [x] PdfTeXEngine.js 분석 — `setTexliveEndpoint()` 버그 확인 (worker ref 소멸)
- [x] 자체 engine wrapper 구현 (버그 회피)
- [x] 엔진 로드 + 소형 문서 컴파일 벤치 코드 작성
- [x] PDF.js 렌더 벤치 코드 작성
- [x] 브라우저에서 실제 벤치마크 실행 및 수치 확정
- [x] Gate 판정: **PASS** — small doc 384ms (< 5s ✓), PDF render 184ms (< 200ms ✓)

### TexLive CDN 문제

- [x] `texlive.swiftlatex.com` / `texlive2.swiftlatex.com` 사망 확인
- [x] Texlive-Ondemand Docker 서버 빌드 성공 (`texlive-server/Dockerfile`)
- [x] Vite 프록시 설정 (`/texlive/` → texlive 컨테이너)
- [x] Docker 환경에서 패키지 로딩 end-to-end 검증

### 해결한 기술 장벽

- [x] Format 호환성: WASM은 pdfTeX 1.40.22 (재빌드 후 확정), Ubuntu 20.04는 1.40.20 — 포맷 재빌드 불가. 해결: 레포 원본 format 사용
- [x] l3backend 버전 체크: 2020-era l3backend는 버전 체크 없어 2020-02-14 format과 호환
- [x] PDF 해상도: devicePixelRatio 적용 (Retina 대응)
- [x] ArrayBuffer detach: PDF 데이터 `.slice()` 복사로 재사용 가능

**Gate:** ✅ 통과 — WASM 브라우저 컴파일 + PDF 렌더 모두 KPI 내

---

## Iteration 1 (4주) — MVP: 브라우저 로컬 컴파일/뷰 ✅

**사용자 가치:** 설치 없이 브라우저에서 논문 템플릿 컴파일/미리보기

<details><summary>상세 체크리스트</summary>

**프로젝트 스캐폴딩:**
- [x] `package.json` (monaco-editor, pdfjs-dist, vite, typescript)
- [x] `tsconfig.json`, `vite.config.ts`
- [x] `index.html` (3분할 레이아웃 셸)
- [x] `src/styles.css` (다크 테마)
- [x] `src/types.ts` (공유 인터페이스)
- [x] `scripts/download-engine.sh`

**엔진 레이어:**
- [x] `src/engine/tex-engine.ts` — `TexEngine` 추상 인터페이스
- [x] `src/engine/swiftlatex-engine.ts` — SwiftLaTeX postMessage wrapper
- [x] `src/engine/compile-scheduler.ts` — 300ms debounce, 단일 컴파일 보장

**에디터:**
- [x] `src/editor/setup.ts` — Monaco 초기화 + Vite worker 설정
- [x] `src/editor/latex-language.ts` — LaTeX Monarch 토크나이저

**뷰어:**
- [x] `src/viewer/pdf-viewer.ts` — PDF.js 캔버스 렌더, 페이지 네비게이션, 줌

**파일 시스템 + UI:**
- [x] `src/fs/virtual-fs.ts` — `Map<string, VirtualFile>`, 기본 `main.tex`
- [x] `src/ui/layout.ts` — 드래그 가능한 divider
- [x] `src/ui/file-tree.ts` — 파일 목록, 클릭 열기, 새 파일/삭제
- [x] `src/ui/error-log.ts` — TeX 에러 파싱, 클릭으로 라인 점프

**통합:**
- [x] `src/main.ts` — 전체 컴포넌트 연결 + 벤치마크
- [x] TypeScript 컴파일 통과
- [x] Vite 빌드 성공

**Docker 개발 환경:**
- [x] `Dockerfile` (app — Vite dev server)
- [x] `texlive-server/Dockerfile` (Texlive-Ondemand — Flask + kpathsea)
- [x] `docker-compose.yml` (app + texlive 서비스)
- [x] 두 이미지 모두 빌드 성공
- [x] `docker compose up` 으로 전체 환경 기동 검증
- [x] 브라우저에서 앱 로드 + 자동 컴파일 확인 (엔진 46ms, 컴파일 251ms)
- [x] 에디터 수정 → PDF 갱신 (1.8s — E2E 자동 검증 통과)
- [x] 파일 트리 동작 확인 (생성/선택/삭제 — E2E 자동 검증 통과)
- [x] TeX 에러 → error log 표시 + 라인 점프 확인 (E2E 자동 검증 통과)
- [x] amsmath 등 추가 패키지 컴파일 확인 (texlive 서버 경유 — E2E 자동 검증 통과)

</details>

**KPI:** 작은 문서 기준 "편집→PDF 갱신" 2–5초라도 일단 동작 ✅

---

## Iteration 2 (4주) — 체감 반응성 1차 ✅

**사용자 가치:** "실시간에 가깝다"는 첫 인상 (입력 중 버벅임 제거)
**KPI:** 타이핑 중 UI 끊김 0, 1–2초 내 갱신 체감

<details><summary>A. 컴파일 파이프라인 개선</summary>

**현재 버그:** `syncAndCompile()`이 `engine.isReady()` 체크로 컴파일 중 파일 sync를 건너뜀.
`writeFile()`도 `checkReady()`가 compiling 상태에서 throw. 결과: 컴파일 중 타이핑하면 변경사항 유실.

WASM worker는 `_compileLaTeX()` 동기 실행 중 메시지 큐 차단 → 컴파일 후 처리됨.
따라서 `writefile` postMessage를 컴파일 중 보내도 안전 (다음 컴파일 전에 처리됨).

**A-1. writeFile/mkdir compiling 허용** ✅
- [x] `swiftlatex-engine.ts`: checkReady → checkInitialized (ready|compiling 허용)
- [x] `swiftlatex-engine.ts`: compile() 전용 checkReady는 유지 (이중 컴파일 방지)

**A-2. syncAndCompile 수정** ✅
- [x] `main.ts`: `syncAndCompile()` — `isReady()` 가드를 `getStatus()` 상태 체크로 교체
- [x] `main.ts`: 엔진 미초기화 시에만 bail, compiling 중에는 파일 sync + schedule 허용

**A-3. 컴파일 세대(generation) 카운터** ✅
- [x] `compile-scheduler.ts`: `generation` 카운터 — schedule()마다 증가
- [x] `compile-scheduler.ts`: compile 시작 시 generation 캡처, 완료 시 최신 아닌 결과면 onResult 생략
- [x] 단위 테스트: 구세대 결과 무시, 최신 결과만 전달

**A-4. 적응형 debounce** ✅
- [x] `compile-scheduler.ts`: 최근 컴파일 시간 추적, debounce 자동 조절
  - `debounceMs = clamp(lastCompileTime * 0.5, 150, 1000)`

**취소 전략:** SwiftLaTeX WASM worker에는 cancel 명령 없음.
- 작은 문서 (<1s): 컴파일 완료 후 결과 폐기 (generation 카운터)
- 큰 문서 (>3s): terminate + reinit 고려 (후속 iteration에서 대응)

</details>

<details><summary>B. Service Worker 패키지 캐시</summary>

- [x] `public/sw.js` 작성: `/texlive/` 요청 인터셉트
  - 200 응답: CacheStorage에 저장 후 반환 (cache-first)
  - 301 응답 (not found): 캐시하지 않음
  - 캐시 이름에 버전 포함 (`texlive-cache-v1`)
- [x] `main.ts`: engine init 전에 SW 등록 (`navigator.serviceWorker.register`)
- [x] E2E 테스트: 두 번째 로드 시 37/37 texlive 요청 SW 캐시에서 서빙 확인

</details>

<details><summary>C. PDF 부드러운 교체 (no-flash update)</summary>

- [x] `pdf-viewer.ts`: 이중 버퍼 전략
  - 새 PDF를 DocumentFragment(오프스크린)에 렌더
  - 렌더 완료 후 `replaceChildren()`으로 한 번에 교체
  - 교체 후 이전 pdfDoc destroy
- [x] 스크롤 위치 보존: 교체 전 `scrollTop` 저장 → 교체 후 복원
- [x] 렌더 중 재렌더 요청 처리: `renderGeneration` 카운터로 stale 렌더 취소

</details>

<details><summary>D. 검증</summary>

- [x] E2E 테스트: 빠른 연속 타이핑 (50자+) → UI 끊김 없음 → 최종 PDF 정확
- [x] E2E 테스트: 컴파일 중 타이핑 → 변경사항이 최종 PDF에 반영됨
- [x] E2E 테스트: SW 캐시 — 두 번째 로드 시 37/37 texlive 요청 캐시 서빙
- [x] E2E 테스트: PDF 이중 버퍼 — MutationObserver로 컨테이너 비워짐 없음 확인

</details>

---

## Iteration 3 (4주) — SyncTeX: PDF 클릭 ↔ 소스 점프 ✅

**사용자 가치:** 생산성 급상승(편집-결과 왕복 비용이 사라짐)
**KPI:** 점프 50ms 내, 정확도(대부분의 텍스트) 95%+

<details><summary>A. Worker 프로토콜 확장 (`readfile` 명령)</summary>

- [x] `swiftlatexpdftex.js` (worker): `readfile` 명령 추가
- [x] `tex-engine.ts`: `readFile(path: string): Promise<string | null>` 인터페이스 추가
- [x] `swiftlatex-engine.ts`: `readFile()` 구현 — worker에 `readfile` postMessage + 응답 대기

</details>

<details><summary>B. Phase 1 — pdf.js 텍스트 기반 inverse search (WASM 변경 없음)</summary>

pdf.js `getTextContent()` API로 PDF 텍스트 + 좌표를 추출하고,
소스 텍스트와 매칭하여 **줄 번호를 역산출**하는 근사 방식.
정확도 ~80-90% (일반 텍스트), 수식/표는 매핑 불가.

- [x] `src/synctex/text-mapper.ts` 생성: PDF 텍스트 ↔ 소스 매핑
- [x] `src/viewer/pdf-viewer.ts`: 클릭 핸들러 (캔버스 좌표 → PDF 좌표)
- [x] `src/main.ts`: inverse search → `revealLine()` 연결
- [x] 단위 테스트 7개, E2E 테스트 1개

</details>

<details><summary>C. Phase 2 — WASM 재빌드 (SyncTeX 활성화)</summary>

pdfTeX 1.40.22를 TeX Live 2020 소스에서 WASM으로 빌드. SyncTeX 포함.
BusyTeX 프로젝트의 2-phase 빌드 방식 참조.

**빌드 파이프라인:** `wasm-build/` 디렉토리에 Docker 기반 빌드 환경 구축.

- [x] `wasm-build/Dockerfile`: `emscripten/emsdk:3.1.46` 기반, TeX Live 2020 소스 클론
- [x] TeX Live 2020 소스에서 SyncTeX 포함 빌드 (`--enable-synctex`, 28개 심볼 rename)
- [x] 2-phase 빌드: Phase 1 native (tangle → C 생성), Phase 2 emcc (WASM 컴파일)
- [x] Worker JS (`worker-template.js`): SyncTeX 데이터 추출 포함
- [x] 빌드 성공: `swiftlatexpdftex.js` (109KB) + `swiftlatexpdftex.wasm` (1.6MB)

**빌드 파일:**

| 파일 | 역할 |
|------|------|
| `wasm-build/Dockerfile` | Emscripten + TeX Live 소스 + Phase 1 baked |
| `wasm-build/Makefile` | 2-phase 빌드 오케스트레이션 |
| `wasm-build/build.sh` | Docker entrypoint (Phase 2 only) |
| `wasm-build/worker-template.js` | Worker JS with SyncTeX extraction |
| `wasm-build/wasm-entry.c` | Custom WASM entry points |
| `wasm-build/kpse-hook.c` | kpathsea → JS network fallback |
| `wasm-build/library.js` | Emscripten JS library bridge |

**빌드 명령:**
```bash
cd wasm-build
docker build --platform linux/amd64 -t pdftex-wasm .    # Phase 1 (cached)
docker run --platform linux/amd64 -v $(pwd)/dist:/dist pdftex-wasm  # Phase 2
cp dist/swiftlatexpdftex.{js,wasm} ../public/swiftlatex/
```

</details>

<details><summary>D. SyncTeX 파서 + 검색 로직</summary>

참조 C 구현(`synctex_parser.c`, Jérôme Laurens) 알고리즘을 충실히 포팅한 트리 기반 파서.

- [x] `src/synctex/synctex-parser.ts`: 참조 알고리즘 포팅 (~840줄)
  - `.synctex.gz` 압축 해제: 브라우저 `DecompressionStream` API
  - 트리 구조: 스택 기반 파싱, parent/children 포인터, friend index
  - inverse search: hbox 스캔 → smallest/deepest container → L/R bracketing
  - forward search: nearest-line zigzag → leaf→ancestor hbox resolution
- [x] 단위 테스트: 31 tests

</details>

<details><summary>E–F. Inverse/Forward Search UI</summary>

- [x] `pdf-viewer.ts`: synctex 우선, text-mapper fallback
- [x] `pdf-viewer.ts`: forward search — 하이라이트 오버레이 2초 후 페이드아웃
- [x] `main.ts`: Cmd/Ctrl+Enter → forward search 연결
- [x] `text-mapper.ts`: `forwardLookup(file, line)` → `PdfLocation | null`

</details>

<details><summary>G–H. 검증 + Polish</summary>

- [x] 정확도: 일반 텍스트 100%, 복합 문서 90%+ (nearest-hbox fallback)
- [x] 성능: inverse 0.02ms, forward 0.006ms (KPI 50ms 대비 **2000배+** 빠름)
- [x] SyncTeX 데이터 생성: 13 inputs, 2 pages, 1191 nodes
- [x] WASM 파일 경로 정규화: `/work/./main.tex` → `main.tex`
- [x] 스크롤 기반 페이지 추적: IntersectionObserver

</details>

### 리스크 및 대안 (사후 분석)

| 리스크 | 결과 | 해결 방법 |
|--------|------|-----------|
| WEB-to-C 재생성 실패 | ✅ 해결 | 2-phase 빌드: Phase 1 native → C 생성, Phase 2 emcc 컴파일 |
| Emscripten 버전 호환 | ✅ 해결 | emsdk 3.1.46 사용 |
| TeX Live recursive make 실패 | ✅ 해결 | targeted library builds (kpathsea, zlib, libpng, xpdf만 빌드) |
| QEMU 에뮬레이션 느림 | ⚠️ 현재 | ARM Mac에서 x86_64 Docker: Phase 1 ~82분, Phase 2 ~30분. CI 이관 필요 |

---

## Iteration 3b — 렌더 파이프라인 리팩터링 + UX ✅

**사용자 가치:** 편집 → PDF 반영이 체감적으로 빨라짐, UI가 한 단계 세련됨

<details><summary>완료 항목</summary>

**인프라**
- [x] `src/perf/metrics.ts`: span 기반 타이밍 수집 + `?perf=1` 디버그 오버레이
- [x] `e2e/perf-benchmark.spec.ts`: 편집→PDF 사이클 + 엔진 로드 시간 E2E 벤치마크

**렌더 파이프라인**
- [x] `src/viewer/page-renderer.ts`: 캔버스 렌더 책임 분리 (canvas pool: recycle/acquire)
- [x] `src/viewer/pdf-viewer.ts`: PageRenderer 위임 + 가시 페이지 우선 렌더링
- [x] IntersectionObserver 기반 스크롤 페이지 추적 + 스크롤 위치 보존

**성능 최적화**
- [x] 가시 페이지 우선 렌더링: 현재 페이지 먼저 렌더 + DOM swap → 나머지 순차
- [x] 캔버스 풀: `PageRenderer`에서 canvas 재사용 (DOM 생성 비용 절감)
- [x] 디바운스 하한 150ms → 50ms (적응형)
- [x] `CompileScheduler.flush()`: Ctrl+S로 디바운스 즉시 소화

**UX 개선**
- [x] 에디터 인라인 에러 마커: `src/ui/error-markers.ts` (Monaco `setModelMarkers`)
- [x] Ctrl/Cmd+S 즉시 컴파일
- [x] PDF 다운로드 버튼
- [x] 줌 레벨 % 표시 + 더블클릭 100% 리셋

</details>

---

## Iteration 3c — CI/CD + gh-pages 배포 ✅

**사용자 가치:** 설치 없이 `https://akcorca.github.io/latex-editor/`에서 에디터 사용 가능

<details><summary>완료 항목</summary>

**GitHub Actions CI**
- [x] `.github/workflows/ci.yml`: lint → tsgo → test → vite build → gh-pages deploy
- [x] `.github/workflows/wasm-build.yml`: Docker 기반 WASM 빌드 (x86_64)

**gh-pages 정적 배포 호환**
- [x] **Base path**: `import.meta.env.BASE_URL`로 모든 정적 자산 경로 수정
- [x] **Format 파일 호환**: SyncTeX WASM 바이너리(1.40.22)용 `.fmt` 추출 (Playwright 자동화)
- [x] **TeX 파일 번들링**: 277개 필수 파일 (13MB) — `scripts/bundle-texlive.mjs`
- [x] **kpse 정적 호스팅 대응**: `fileid`/`pkid` 헤더 없는 환경 + 404 캐싱
- [x] **Service Worker**: base-path-aware fetch 핸들러

</details>

**배포 현황:**
- **URL**: `https://akcorca.github.io/latex-editor/`
- **정적 자산**: WASM 1.6MB + worker 132KB + .fmt 2.3MB + texlive 13MB ≈ **17MB total**
- **제약**: 번들에 포함된 패키지만 사용 가능 (article, amsmath, amssymb, amsthm + 의존성)

---

## Iteration 4 — Preamble Snapshot ✅

**사용자 가치:** body 편집 시 컴파일 ~40% 빠름 (preamble 재처리 생략)

**접근법:** C 코드 변경 없이, TeX의 `\dump` primitive로 preamble 상태를 format 파일로 캐싱.
`\begin{document}` 앞의 preamble을 `-ini` 모드로 빌드 → `.fmt` 파일 생성.
이후 body 편집 시 cached format을 로드하여 preamble 처리를 완전 건너뜀.

- [x] **Worker**: `extractPreamble()`, `simpleHash()`, `buildPreambleFormat()` — preamble 분석 + format 빌드
- [x] **Worker**: HIT/MISS 로직 — hash 비교로 preamble 변경 감지, 자동 fallback
- [x] **Worker**: SyncTeX 라인 보존 — body 파일에 `%` 주석줄 패딩
- [x] **Host**: `CompileResult.preambleSnapshot` 플래그, 상태바 "(cached preamble)" 표시
- [x] **Tests**: preamble-utils 단위 테스트 10개, E2E 테스트 3개

### 벤치마크

| 항목 | 시간 |
|------|------|
| Preamble format 빌드 (MISS, 1회) | 198ms |
| Body 컴파일 (HIT, cold) | 441ms |
| Body 컴파일 (HIT, warm) | 258–302ms |
| 추정 full 컴파일 (preamble 없이) | ~460ms |
| **체감 개선** | **~40% 빠름** |

### 제약 사항 (해소됨)

- ~~Preamble format은 **첫 컴파일 시에만** 빌드 가능~~ → `runMain()` 전환으로 해결 (I4c, 커밋 `33df703`)
- 모든 컴파일이 `runMain()` → `_main()` 경유. `_mainCallSafe` 게이트 제거로 세션 중 preamble 재빌드 가능.

---

## Iteration 4b — 컴포넌트 API + 라이브러리 빌드 ✅

**사용자 가치:** 호스트 제품에 `<script>` 한 줄로 LaTeX 에디터 임베드 가능

- [x] `src/latex-editor.ts`: `LatexEditor` 클래스 (533줄) — `init()`, `loadProject()`, `saveProject()`, `compile()`, 이벤트 시스템
- [x] `src/index.ts`: 라이브러리 엔트리포인트 (LatexEditor + 타입 export)
- [x] `vite.config.ts`: `BUILD_MODE=lib` → Vite library mode (ES module 출력)
- [x] `examples/embed.html`: 최소 임베딩 예시
- [x] CSS를 ID 셀렉터에서 scoped `.le-*` 클래스로 전환 (임베딩 안전성)

---

## Iteration 4c — 컴파일 흐름 수정 + WASM 버그 수정 ✅

**사용자 가치:** 세션 중 preamble 변경해도 format 재빌드 동작, 반복 컴파일 안정성

### `runMain()` 전환 (커밋 `33df703`)
- [x] 모든 컴파일을 `runMain()` → `_main()` 경유로 통일
- [x] `_mainCallSafe` 게이트 제거 → 세션 중 preamble format 재빌드 가능
- [x] Monaco 모델 dispose 순서 수정 (Delayer cancellation error 방지)

### WASM heap restore 버그 수정 (커밋 `4fcba76`)
- [x] `restoreHeapMemory()`: `memory.grow()` 확장 영역에 스테일 데이터 잔존
- [x] 증상: "Command already defined" / "Can be used only in preamble" / "text input levels=15"
- [x] 수정: `dst.fill(0, self.initmem.length)` — 확장 영역 제로 초기화

### 기타 polish
- [x] IndexedDB 제거 — 컴포넌트는 stateless, 호스트가 저장 담당 (설계 확정)
- [x] 자동 재컴파일: "Rerun to get cross-references right" 감지 시 자동 재실행
- [x] 데모 문서를 7페이지 수학 서베이로 교체
- [x] PDF 뷰어 로딩 오버레이 (Loading engine → Compiling → Rendering PDF)

---

## Iteration 5a — 정적 LaTeX LSP ✅

**사용자 가치:** IDE 수준의 자동완성, go-to-definition, hover, 문서 outline, find references

엔진 트레이스 없이 정적 분석(regex 기반)으로 구현. 브라우저에서 완전히 동작.

- [x] `src/lsp/latex-parser.ts`: regex 기반 LaTeX 파서
- [x] `src/lsp/aux-parser.ts`: `.aux` 파일 파서 (크로스 레퍼런스)
- [x] `src/lsp/completion-provider.ts`: 컨텍스트 인식 자동완성 (~150 명령어, ~40 환경, `\ref`/`\cite`/`\begin`/`\usepackage`/`\input`)
- [x] `src/lsp/definition-provider.ts`: 크로스 파일 go-to-definition
- [x] `src/lsp/hover-provider.ts`: 호버 문서
- [x] `src/lsp/symbol-provider.ts`: 문서 outline (섹션, 라벨 등)
- [x] `src/lsp/reference-provider.ts`: find all references
- [x] `src/lsp/project-index.ts`: 파일 간 심볼 추적 + `.aux` 데이터 통합
- [x] `src/lsp/latex-patterns.ts`: 공유 패턴 상수 추출 (중복 제거)
- [x] 단위 테스트: `aux-parser`, `completion-provider`, `latex-parser`, `project-index` (4 파일)

### 현재 LSP 상태

| 기능 | 구현 | 정확도 |
|------|------|--------|
| 자동완성 (명령어/환경) | ✅ 정적 DB | 높음 (내장 150개 명령어) |
| 자동완성 (`\ref`/`\cite`) | ✅ `.aux` 파서 기반 | 높음 (컴파일 후 갱신) |
| Go-to-definition | ✅ 크로스 파일 | 높음 |
| Hover 문서 | ✅ 정적 DB | 높음 |
| Document outline | ✅ 심볼 프로바이더 | 높음 |
| Find references | ✅ 프로젝트 인덱스 | 높음 |
| 패키지 명령어 자동완성 | ✅ 엔진 해시 테이블 스캔 (I5b) | 높음 |
| 매크로 확장 추적 | ❌ 미구현 (I5b Phase 2) | — |

---

## Iteration 5b — Semantic Trace Phase 1 (해시 테이블 스캔) ✅

**사용자 가치:** 패키지 명령어도 자동완성 — `\usepackage{amsmath}` 후 `\inter` 입력 시 `\intertext` 등 모든 정의된 명령어 제안

**접근법:** pdfTeX 컴파일 후 WASM 힙에 남아 있는 해시 테이블을 스캔하여 모든 정의된 제어 시퀀스를 추출. C 함수 → MEMFS 파일 → Worker JS → TypeScript LSP로 전달.

<details><summary>A. C 해시 테이블 스캐너</summary>

- [x] `wasm-build/trace-hook.c`: `scanHashTable()` — pdfTeX `hash[514..hashtop]` 순회
  - web2c wasm32 레이아웃 독립 타입 정의 (pdftexd.h include chain 회피)
  - 필터: 빈 슬롯, undefined CS (`zeqtb[p].hh.u.B0 == 0`), 1문자, `@` 포함, 200자 초과
  - 결과를 `/work/.commands`에 newline-delimited로 출력
- [x] `wasm-build/Makefile`: `TRACE_HOOK`, `_scanHashTable` export, 소스 파일 추가
- [x] `wasm-build/Dockerfile`: `COPY trace-hook.c /src/trace-hook.c`

</details>

<details><summary>B. Worker 통합</summary>

- [x] `wasm-build/worker-template.js`: `_scanHashTable()` 호출 → MEMFS 읽기 → `engineCommands` 배열로 응답
- [x] `public/swiftlatex/swiftlatexpdftex.js`: 동일 변경 (try/catch로 WASM 미빌드 시 graceful 처리)
- [x] 타이밍: `restoreHeapMemory()` 전 실행 → 컴파일 후 힙 상태 온전

</details>

<details><summary>C. TypeScript LSP 통합</summary>

- [x] `src/types.ts`: `CompileResult.engineCommands?: string[]`
- [x] `src/engine/swiftlatex-engine.ts`: Worker 응답에서 `engineCommands` 추출
- [x] `src/lsp/project-index.ts`: `updateEngineCommands()` / `getEngineCommands()`
- [x] `src/lsp/completion-provider.ts`: Tier 3 `appendEngineCommands()` — 중복 제거 + `sortText: '2_'`
- [x] `src/latex-editor.ts`: 컴파일 결과에서 `engineCommands` → `projectIndex` 전달

</details>

<details><summary>D. CI/빌드</summary>

- [x] `.github/workflows/wasm-build.yml`: `feat/semantic-trace` 브랜치 트리거 + `_scanHashTable` 스모크 테스트
- [x] GitHub Actions에서 WASM 빌드 성공 (4m28s, native amd64)
- [x] 빌드된 바이너리를 `public/swiftlatex/`에 반영

</details>

### 3-tier 자동완성 구조

| Tier | 소스 | sortText | Kind |
|------|------|----------|------|
| 0 | 정적 DB (~150 명령어) | `0_` | Function |
| 1 | 사용자 정의 (`\newcommand` regex) | `1_` | Variable |
| 2 | 엔진 해시 테이블 (패키지 명령어) | `2_` | Text |

---

## Iteration 5c — 정적 번들 최적화 ✅

**사용자 가치:** 초기 로드 전송량 대폭 감소 (gh-pages에서 체감 속도 향상)

### Phase 1: 비영어 하이프네이션 파일 제거 (~3.0MB 절감)

`.fmt` 파일에 모든 언어의 하이프네이션 trie가 baked-in 되어 있으므로 소스 `.tex` 파일은 static bundle에서 불필요.

- [x] `public/texlive/pdftex/26/`: 156개 비영어 하이프네이션 파일 삭제 (6.7MB → 3.7MB)
- [x] `scripts/bundle-texlive.mjs`: `isNonEnglishHyphenation()` 필터 추가 (재번들 시 자동 제외)
- [x] 영어 파일 유지: `hyph-en-{us,gb}.tex`, `loadhyph-en-{us,gb}.tex`, `hyphen.tex`, `hyphen.cfg`, `language.dat`, `dumyhyph.tex`, `zerohyph.tex`

### Phase 2-3: pdftex.map gzip 프리로드 + onmessage 리팩터

`pdftex.map`(4.6MB)은 gzip 시 371KB로 92% 축소. 엔진 init 시 메인 스레드에서 `.gz` fetch → 해제 → 워커 MEMFS에 주입.

- [x] `scripts/compress-assets.mjs`: pdftex.map gzip 압축 스크립트 (4.6MB → 371KB)
- [x] `src/engine/swiftlatex-engine.ts`: `pendingResponses` Map 기반 단일 onmessage 핸들러로 리팩터 (기존: 각 메서드가 `onmessage` 교체 → 순차 전용)
- [x] `src/engine/swiftlatex-engine.ts`: `fetchGzWithFallback()` — `.gz` 우선 fetch + `DecompressionStream` 해제, fallback raw fetch
- [x] `src/engine/swiftlatex-engine.ts`: `preloadTexliveFile()` — format/filename/gzUrl → 워커 MEMFS 주입
- [x] `src/engine/swiftlatex-engine.ts`: `init()` — `preloadFormat()` + `preloadTexliveFile(pdftex.map)` 병렬 실행 (`Promise.all`)
- [x] `public/swiftlatex/swiftlatexpdftex.js` + `wasm-build/worker-template.js`: `preloadtexlive` 커맨드 추가

### 결과

| 자산 | Before | After | Transfer (gzip) |
|------|--------|-------|-----------------|
| texlive/26/ | 6.7MB (213 files) | 3.7MB (57 files) | ~1.0MB |
| texlive/11/pdftex.map | 4.6MB (sync XHR) | 4.6MB + 371KB .gz | **371KB** (preload) |
| swiftlatex/fmt | 2.3MB | 2.3MB (high entropy, gzip 무효) | ~2.3MB |
| swiftlatex/wasm | 1.6MB | 1.6MB | ~0.5MB (CDN gzip) |

---

# Part III. 로드맵 (미구현)

## Iteration 5b Phase 2 — Semantic Trace (매크로 확장 트레이스)

**사용자 가치:** "매크로 확장도 추적, 엔진 기반 정밀 진단"

**선행 완료:** Phase 1 (I5b, 해시 테이블 스캔) → 패키지 명령어 자동완성.
나머지는 pdfTeX C 코드에 semantic trace 훅을 추가하여 매크로 확장을 실시간 추적:

* 매크로 확장 시점에 구조화 이벤트 emit (label, ref, cite, section, include, newcommand)
* 정적 파서가 아닌 엔진 실행 트레이스 기반 → LaTeX 특유의 매크로 확장도 정확하게 추적
* WASM 빌드 파이프라인(`wasm-build/`) 활용

**KPI:** 매크로 확장 결과 기반 진단, 엔진 트레이스가 LSP "진실 소스"로 승격

---

## Iteration 6 — PDL + LiveView: 즉시 반응

**사용자 가치:** "타이핑하면 50ms 내 페이지가 움직인다"

pdfTeX `ship_out()`에 PDL 출력 드라이버 추가. WebGPU로 PDL 렌더.

* PDL: glyph runs (font, glyph id, position) + images + vector paths + 소스 span
* WebGPU 렌더러: glyph atlas, 타일링, 뷰포트 렌더, 스크롤/줌 60fps
* "LiveView 즉시 반응" + 백그라운드 PDF 수렴 → 스왑/오버레이
* Interruptible compilation: `emscripten_sleep()` yield points (Asyncify)

**KPI:** Keystroke→화면 변화 30-80ms 달성

---

## Iteration 7 — 대형 문서 + 안정화

**사용자 가치:** "100페이지 논문도 쾌적"

* `\include` 단위 부분 컴파일: 현재 챕터만 즉시 컴파일, 전체는 백그라운드
* 또는 section 경계 체크포인트 (Preamble snapshot 확장)
* PDF.js 캐시/타일링/프리페치 강화
* arXiv급 코퍼스 회귀 테스트 파이프라인
* `tex.lock` 도입 (패키지 버전 고정 + 재현성)

**KPI:** 대형 문서 "현재 페이지" 업데이트 < 500ms, 실패율/크래시율 목표 달성

---

## Iteration 8 — 서버 fallback + 프로젝트 관리

**사용자 가치:** "어떤 패키지/문서 크기여도 일단 된다" + 폴더 구조로 실제 프로젝트 관리 가능

### A. 서버 컴파일 fallback

* 자동 fallback 조건: 패키지 미지원, WASM 메모리 초과, 타임버짓 초과
* Phase 1: REST API (POST source → PDF + SyncTeX + log). WebSocket 스트리밍은 이후.
* 서버 엔진: full TeX Live (pdfTeX + XeTeX + LuaTeX) — WASM이 못 하는 것을 커버
* 동일 UI/동일 기능 유지 (사용자는 로컬/서버를 의식하지 않음)

### B. 프로젝트 관리

* 폴더 구조 지원 (VirtualFS 확장)
* 이미지/바이너리 파일 업로드 (drag & drop → engine writeFile)
* BibTeX/Biber 지원: WASM bibtex 또는 서버 fallback

**KPI:** 실패율 급감, 이미지 포함 문서 컴파일 가능, BibTeX 동작

---

## Iteration 9 — 템플릿 + 패키지 확장

**사용자 가치:** "학회 템플릿 골라서 바로 시작"

* 템플릿 갤러리: 학회/저널별 사전 구성된 프로젝트 번들
* 패키지 whitelist 확장 + 의존성 그래프 도구 (내부)
* 호스트 제품과의 통합 인터페이스 정의 (프로젝트 로드/저장 API)

**KPI:** 템플릿 온보딩 1분 이내

---

## 호스트 제품 연동 (이 컴포넌트 범위 밖)

이하 기능은 호스트 제품의 책임이며, 이 컴포넌트는 API/이벤트 인터페이스만 제공한다.

* **사용자 계정 + 클라우드 저장**: 호스트가 인증/저장 담당. 컴포넌트는 `loadProject(files)` / `saveProject()` 인터페이스 노출.
* **실시간 협업**: 호스트가 CRDT/OT + WebSocket 담당. 컴포넌트는 `applyEdit(range, text)` / `onContentChange` 이벤트 인터페이스 노출.
* **권한/공유/버전 관리**: 호스트 책임.

---

# Part IV. 현재 상태 요약

## 완료된 Iteration

| Iteration | 내용 | 상태 |
|-----------|------|------|
| I0 | 리스크 스파이크 (엔진 선정, 벤치마크) | ✅ |
| I1 | MVP: 브라우저 로컬 컴파일/뷰 | ✅ |
| I2 | 체감 반응성 (cancel/debounce + SW 캐시 + PDF 이중버퍼) | ✅ |
| I3 | SyncTeX 양방향 검색 (WASM 재빌드 포함) | ✅ |
| I3b | 렌더 파이프라인 리팩터링 + UX polish | ✅ |
| I3c | CI/CD + gh-pages 정적 배포 | ✅ |
| I4 | Preamble snapshot (~40% 컴파일 단축) | ✅ |
| I4b | 컴포넌트 API + 라이브러리 빌드 | ✅ |
| I4c | 컴파일 흐름 수정 + WASM 버그 수정 | ✅ |
| I5a | 정적 LaTeX LSP (completion, go-to-def, hover, symbols, refs) | ✅ |
| I5b | Semantic Trace Phase 1 (해시 테이블 스캔 → 패키지 명령어 자동완성) | ✅ |
| I5c | 정적 번들 최적화 (hyph 제거, pdftex.map gzip preload, onmessage 리팩터) | ✅ |

## 코드베이스 현황

| 지표 | 수치 |
|------|------|
| TypeScript 소스 | 34 파일, ~5,800줄 (프로덕션) |
| 단위 테스트 | 10 파일, ~2,100줄 |
| E2E 테스트 | 8 스펙, ~1,070줄 |
| WASM 빌드 | 7 파일 (Dockerfile, Makefile, build.sh, worker-template.js, wasm-entry.c, kpse-hook.c, trace-hook.c) |
| 런타임 의존성 | 2개 (monaco-editor, pdfjs-dist) |
| 정적 자산 | WASM 1.6MB + worker 137KB + .fmt 2.3MB + texlive 8.7MB ≈ 13MB (raw), ~4MB (gzip transfer) |
| 배포 | https://akcorca.github.io/latex-editor/ |

## 다음 작업 우선순위

### ~~Option A: 정적 번들 최적화~~ → ✅ 완료 (I5c)

### ~~Option B-1: 해시 테이블 스캔~~ → ✅ 완료 (I5b Phase 1)

### Option B-2: Semantic Trace Phase 2 (매크로 확장 트레이스)

해시 테이블 스캔으로 패키지 명령어는 커버됨. 남은 부분:

1. pdfTeX C 코드에 매크로 확장 시점 훅 (label, ref, cite, section, include 이벤트)
2. 매크로 확장 결과 기반 정확한 진단
3. 엔진 트레이스 → LSP "진실 소스" 승격

### Option C: PDL + LiveView (I6, 대형)

가장 야심찬 목표 — 타이핑 30-80ms 내 화면 반응:

1. pdfTeX `ship_out()` PDL 출력 드라이버
2. WebGPU 렌더러 (glyph atlas, 타일링)
3. Interruptible compilation (Asyncify)

### Option D: 서버 fallback + 프로젝트 관리 (I8)

실용적 완성도 — 어떤 패키지/문서도 컴파일 가능:

1. WASM 실패 시 서버 자동 전환 (REST API)
2. 폴더 구조, 이미지 업로드, BibTeX 지원
3. XeTeX/LuaTeX는 서버 전용
