# Plan

Overleaf를 월등하게 이길 수 있는 LaTeX 편집/컴파일/프리뷰 컴포넌트. 독립 제품이 아니라 **호스트 제품에 임베드**되는 구조이므로, 계정/인증/클라우드 저장/협업은 호스트 책임이고, 이 컴포넌트는 아래 네 가지에 집중한다:

* **(A) 즉시 반응하는 뷰(프리뷰 파이프라인)**
* **(B) 정확도를 수렴시키는 권위 엔진(TeX)**
* **(C) 두 세계를 연결하는 의미/좌표 매핑**
* **(D) 패키지/리소스/보안/재현성**

다음은 **실제로 Overleaf보다 체감적으로 빨라질 가능성이 높은 설계**와 **Iteration 단위 실행 계획**

---

## 1) 목표를 수치로 못 박기 (성공 조건)

### UX KPI (체감 성능)

* **Keystroke → 화면 변화(무언가라도)**: 30–80ms (P50), 150ms (P95)
* **Keystroke → “정확한 결과로 수렴”(권위 렌더)**: 300–1200ms (문서 크기에 따라)
* **PDF 클릭 → 소스 점프**: 50ms 이내
* **스크롤/줌 FPS**: 60fps 유지(대부분의 장면)
* **대형 문서(100p)**: “현재 페이지”는 200ms 내 업데이트, 전체는 비동기 수렴

이 수치가 나오려면 “매번 PDF 전체 재생성+재파싱”만으로는 어렵습니다. 그래서 아래 아키텍처가 필요합니다.

---

## 2) 제안 아키텍처: "권위(TeX) + 실시간(렌더러) 분리"가 핵심

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

#### (1) Preamble snapshot (성능 레버)

* Emscripten `Module.HEAP`를 `ArrayBuffer.slice()`로 통째로 저장
* preamble 처리 후 스냅샷 → body 편집 시 복원 후 재개
* 대안: `\dump` primitive로 custom format 생성 (기존 `swiftlatexpdftex.fmt`도 이 방식)
* 효과: 반복 편집의 80%는 preamble 변화 없음 → 컴파일 시간 절반 이하

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

#### (4) Semantic Trace

* 매크로 확장 시점에 구조화 이벤트 emit (label, ref, cite, section, include)
* C 레벨 훅 또는 TeX 매크로 레벨 모두 가능
* LSP의 "진실"을 정적 파서가 아닌 엔진 실행 트레이스로 구성
* 효과: Overleaf+일반 에디터 조합을 넘어서는 정확한 자동완성/진단

---

## 4) GPU/WebGPU는 어디에 쓰는 게 “효과가 큰가”

### (A) 가장 큰 효과: **렌더링**

* LiveView(WebGPU): PDL 렌더 → 스크롤/줌/페이지 교체가 매우 빠름
* PDF.js 커스터마이징: 장기적으로 WebGPU backend로 이관 가능

  * 텍스트: glyph atlas (SDF/MSDF)
  * 벡터: path tessellation 캐시
  * 이미지: GPU 텍스처 캐시
  * 뷰포트/타일링: 화면에 보이는 부분만 그리기

### (B) 타입세팅 계산 GPU 가속은 “연구 베팅”

Knuth–Plass line breaking 같은 DP는 GPU로도 가능하지만, 구현/디버깅 대비 이득이 불확실합니다.
현실적 우선순위는:

1. **WASM SIMD + 멀티스레드(SharedArrayBuffer)**로 폰트/레이아웃/로그 처리 최적화 (pdfTeX WASM에 적용)
2. GPU는 **그린 픽셀(렌더)**에 집중

---

## 5) WebSocket을 “fallback” 이상의 무기로 쓰는 방법

서버 fallback을 단순 “느리면 서버 컴파일”로 끝내지 말고:

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

Whitelist 기반이면 “점진적 확장”을 제품적으로 운영 가능하게 만들어야 합니다.

### 제안: TeX용 lockfile + bundle registry

* 프로젝트에 `tex.lock`(개념적으로):

  * TeX bundle 버전(TeX Live 스냅샷 유사)
  * 허용 패키지 목록
  * 각 패키지 해시(또는 Merkle root)
* 브라우저는 필요한 패키지를 CDN에서 lazy fetch, 해시 검증 후 캐시
* 서버 fallback도 동일한 lock을 사용 → 결과 재현

이게 있으면:

* “내 컴퓨터/네 컴퓨터에서 결과가 다름” 문제를 크게 줄이고,
* 템플릿/학회 스타일 제공이 제품적으로 쉬워집니다.

---

# 7) Iteration 단위 실행 계획 (2년 / 빠른 출시 / 매 Iteration 사용자 가치 상승)

아래는 “주요 Iteration(릴리즈 단위)”입니다. 내부적으로는 2주 스프린트로 쪼개되, **각 Iteration 종료마다 사용자가 체감하는 가치가 분명히 증가**하도록 설계했습니다.

## Iteration 0 (2주) — 리스크 제거 스파이크

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

- [x] Format 호환성: WASM은 pdfTeX 1.40.21, Ubuntu 20.04는 1.40.20 — 포맷 재빌드 불가. 해결: 레포 원본 format 사용
- [x] l3backend 버전 체크: 2020-era l3backend는 버전 체크 없어 2020-02-14 format과 호환
- [x] PDF 해상도: devicePixelRatio 적용 (Retina 대응)
- [x] ArrayBuffer detach: PDF 데이터 `.slice()` 복사로 재사용 가능

**Gate:** ✅ 통과 — WASM 브라우저 컴파일 + PDF 렌더 모두 KPI 내

---

## Iteration 1 (4주) — MVP: 브라우저 로컬 컴파일/뷰

**사용자 가치:** 설치 없이 브라우저에서 논문 템플릿 컴파일/미리보기

### 진행 상태

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

**KPI:** 작은 문서 기준 "편집→PDF 갱신" 2–5초라도 일단 동작

---

## Iteration 2 (4주) — 체감 반응성 1차: cancel/debounce + 캐시

**사용자 가치:** "실시간에 가깝다"는 첫 인상 (입력 중 버벅임 제거)

**KPI:** 타이핑 중 UI 끊김 0, 1–2초 내 갱신 체감

**여기서 알파 출시 가능**

### A. 컴파일 파이프라인 개선

**현재 버그:** `syncAndCompile()`이 `engine.isReady()` 체크로 컴파일 중 파일 sync를 건너뜀.
`writeFile()`도 `checkReady()`가 compiling 상태에서 throw. 결과: 컴파일 중 타이핑하면 변경사항 유실.

WASM worker는 `_compileLaTeX()` 동기 실행 중 메시지 큐 차단 → 컴파일 후 처리됨.
따라서 `writefile` postMessage를 컴파일 중 보내도 안전 (다음 컴파일 전에 처리됨).

**A-1. writeFile/mkdir compiling 허용** ✅
- [x] `swiftlatex-engine.ts`: checkReady → checkInitialized (ready|compiling 허용)
- [x] `swiftlatex-engine.ts`: compile() 전용 checkReady는 유지 (이중 컴파일 방지)
- [x] 검증: `npx tsgo --noEmit && npx vitest run`

**A-2. syncAndCompile 수정** ✅
- [x] `main.ts`: `syncAndCompile()` — `isReady()` 가드를 `getStatus()` 상태 체크로 교체
- [x] `main.ts`: 엔진 미초기화 시에만 bail, compiling 중에는 파일 sync + schedule 허용
- [x] 검증: `npx tsgo --noEmit`

**A-3. 컴파일 세대(generation) 카운터** ✅
- [x] `compile-scheduler.ts`: `generation` 카운터 — schedule()마다 증가
- [x] `compile-scheduler.ts`: compile 시작 시 generation 캡처, 완료 시 최신 아닌 결과면 onResult 생략
- [x] 단위 테스트: 구세대 결과 무시, 최신 결과만 전달
- [x] 검증: `npx vitest run` (35 tests pass)

**A-4. 적응형 debounce** ✅
- [x] `compile-scheduler.ts`: 최근 컴파일 시간 추적, debounce 자동 조절
  - `debounceMs = clamp(lastCompileTime * 0.5, 150, 1000)`
- [x] 단위 테스트: 컴파일 시간에 따라 debounce 변화 확인 (4 tests)
- [x] 검증: `npx vitest run`

**A-5. init() 벤치마크 제거** ✅
- [x] `main.ts`: 벤치마크 코드 없음 확인, main.tex 직접 컴파일만
- [x] 검증: `npx tsgo --noEmit && npx biome check src/`

**A-6. 통합 검증** ✅
- [x] 전체 체크: `npx tsgo --noEmit && npx biome check src/ && npx vitest run` — 35 tests pass

**취소 전략:** SwiftLaTeX WASM worker에는 cancel 명령 없음 (`grace` = worker 종료만 가능).
`worker.terminate()` + reinit는 ~46ms + 패키지 캐시 소실. 현실적 선택:
- 작은 문서 (<1s): 컴파일 완료 후 결과 폐기 (generation 카운터)
- 큰 문서 (>3s): terminate + reinit 고려 (Iteration 9에서 본격 대응)

### B. Service Worker 패키지 캐시

**현재:** 매 페이지 로드마다 패키지 재요청. WASM worker 내부 404 캐시만 존재.
패키지 파일은 불변 (같은 이름 = 같은 내용) → cache-first 전략 적합.

- [x] `public/sw.js` 작성: `/texlive/` 요청 인터셉트
  - 200 응답: CacheStorage에 저장 후 반환 (cache-first)
  - 301 응답 (not found): 캐시하지 않음
  - 캐시 이름에 버전 포함 (`texlive-cache-v1`)
- [x] `main.ts`: engine init 전에 SW 등록 (`navigator.serviceWorker.register`)
- [x] SW lifecycle 처리: install (`skipWaiting`), activate (구버전 캐시 정리 + `clients.claim`)
- [x] Vite dev 호환: SW는 Vite proxy와 독립 동작 (proxy 응답을 캐시)
- [x] E2E 테스트: 두 번째 로드 시 37/37 texlive 요청 SW 캐시에서 서빙 확인

### C. PDF 부드러운 교체 (no-flash update) ✅

**현재:** `render()`가 `pdfDoc.destroy()` + `innerHTML = ''` 후 새 페이지 렌더 → 빈 화면 깜빡임.

- [x] `pdf-viewer.ts`: 이중 버퍼 전략
  - 새 PDF를 DocumentFragment(오프스크린)에 렌더
  - 렌더 완료 후 `replaceChildren()`으로 한 번에 교체
  - 교체 후 이전 pdfDoc destroy
- [x] 스크롤 위치 보존: 교체 전 `scrollTop` 저장 → 교체 후 복원
- [x] 페이지 수 변화 대응: `currentPage` 클램프
- [x] 렌더 중 재렌더 요청 처리: `renderGeneration` 카운터로 stale 렌더 취소

### D. 정리 + 검증 ✅

- [x] E2E 테스트: 빠른 연속 타이핑 (50자+) → UI 끊김 없음 → 최종 PDF 정확
- [x] E2E 테스트: 컴파일 중 타이핑 → 변경사항이 최종 PDF에 반영됨
- [x] E2E 테스트: SW 캐시 — 두 번째 로드 시 37/37 texlive 요청 캐시 서빙
- [x] E2E 테스트: PDF 이중 버퍼 — MutationObserver로 컨테이너 비워짐 없음 확인
- [x] 콘솔 성능 측정: 기존 로깅 유지 (Engine load, Compile, PDF render)
- [x] `docs/plan.md` 체크리스트 업데이트

### 파일 변경 예상

| 파일 | 작업 |
|------|------|
| `src/engine/swiftlatex-engine.ts` | writeFile/mkdir compiling 허용 |
| `src/engine/compile-scheduler.ts` | generation 카운터, 적응형 debounce |
| `src/engine/compile-scheduler.test.ts` | 새 로직 단위 테스트 추가 |
| `src/main.ts` | syncAndCompile 수정, 벤치마크 제거, SW 등록 |
| `src/viewer/pdf-viewer.ts` | 이중 버퍼, 스크롤 보존 |
| `public/sw.js` | 신규 — Service Worker |
| `e2e/iteration2.spec.ts` | 신규 — E2E 검증 |

---

## Iteration 3 (4주) — SyncTeX: PDF 클릭 ↔ 소스 점프

**사용자 가치:** 생산성 급상승(편집-결과 왕복 비용이 사라짐)

**KPI:** 점프 50ms 내, 정확도(대부분의 텍스트) 95%+

**이 시점에 "초기 제품"으로 공개 베타가 가능**

### 기술 현황 분석

**SyncTeX 상태:** SwiftLaTeX WASM 바이너리에서 SyncTeX 코드 **완전 제거**.
- `strings swiftlatexpdftex.wasm | grep synctex` → 0건
- `pdftex0.c`, `pdftexini.c`에 synctex 참조 없음 (WEB-to-C 변환 시 제외)
- `pdftexcoerce.h`에 `#include <synctexdir/synctex.h>` 잔존하나 실제 디렉토리 없음
- `\synctex=1` TeX primitive도 동작 불가 (바이너리에 코드 자체가 없음)

**Source specials 상태:** 바이너리에 `src:`, `src:%d` 문자열 존재.
- `makesrcspecial()` 코드가 컴파일됨
- 단, PDF 모드에서 `src:` specials는 무시됨 (DVI 전용) → 사용 불가

**Worker 프로토콜:** 파일 읽기 명령 없음 (write만 가능). compile 결과로 PDF + log만 반환.
WASM FS에서 `FS.readFile()`은 가능 (PDF 읽기에 이미 사용 중).

**결론:** WASM 재빌드가 필수. 2-phase 접근:
- Phase 1: pdf.js 텍스트 추출 기반 **근사** inverse search (WASM 변경 없이 즉시 가능)
- Phase 2: WASM 재빌드 + SyncTeX로 **정밀** 양방향 검색

---

### A. Worker 프로토콜 확장 (`readfile` 명령) ✅

SyncTeX든 텍스트 기반이든 WASM FS에서 파일을 읽어올 수 있어야 한다.
Phase 2에서 `.synctex` 파일 읽기에 필수, Phase 1에서도 `.aux` 등 디버깅에 유용.

- [x] `swiftlatexpdftex.js` (worker): `readfile` 명령 추가
  - WASM 파일은 gitignored → `scripts/download-engine.sh`에 패치 스크립트 추가
- [x] `tex-engine.ts`: `readFile(path: string): Promise<string | null>` 인터페이스 추가
- [x] `swiftlatex-engine.ts`: `readFile()` 구현 — worker에 `readfile` postMessage + 응답 대기
- [x] `main.ts`: `window.__engine`으로 E2E 테스트에 노출
- [x] E2E 검증: 컴파일 후 `readFile('main.log')` → TeX 로그 반환 확인
- [x] 커밋: `dc0bdda`

### B. Phase 1 — pdf.js 텍스트 기반 inverse search (WASM 변경 없음) ✅

pdf.js `getTextContent()` API로 PDF 텍스트 + 좌표를 추출하고,
소스 텍스트와 매칭하여 **줄 번호를 역산출**하는 근사 방식.
정확도 ~80-90% (일반 텍스트), 수식/표는 매핑 불가.

- [x] `src/synctex/text-mapper.ts` 생성: PDF 텍스트 ↔ 소스 매핑
  - `indexPage()`: `page.getTextContent()` → TextBlock[] (text, x, y, width, height)
  - `lookup()`: 가장 가까운 TextBlock 찾기 → 소스 텍스트 매칭 → 줄 번호 반환
  - `setSource()`: 다중 소스 파일 등록, `findInSources()`: 전체 소스 검색
  - 정확 매칭 + 부분 매칭 (10+ chars prefix) 지원
- [x] `src/viewer/pdf-viewer.ts`: Cmd/Ctrl+클릭 핸들러
  - 캔버스 좌표 → PDF 좌표(pt): `x / scale`, `y / scale`
  - `textMapper.lookup()` → `onInverseSearch` 콜백
  - 컴파일 후 전체 페이지 텍스트 인덱싱 (`textMapper.indexPage()`)
- [x] `src/main.ts`: `pdfViewer.setInverseSearchHandler()` → `revealLine()` 연결
  - `onCompileResult`에서 모든 FS 파일을 `setSourceContent()`로 등록
- [x] 단위 테스트: 7 tests (index+lookup, empty page, not found, closest block, partial match, clear, multi-file)
- [x] E2E 테스트: `e2e/inverse-search.spec.ts` — Cmd+click → editor still functional
- [x] 커밋: `28e4ca0`

### C. Phase 2 — WASM 재빌드 (SyncTeX 활성화) ✅

pdfTeX 1.40.21을 TeX Live 2020 소스에서 WASM으로 빌드. SyncTeX 포함.
BusyTeX 프로젝트의 2-phase 빌드 방식 참조 (Phase 1: native web2c → C 생성, Phase 2: emcc WASM 컴파일).

**빌드 파이프라인:** `wasm-build/` 디렉토리에 Docker 기반 빌드 환경 구축.
- Phase 1 (native) Docker 이미지에 baked → 캐시 활용
- Phase 2 (WASM) `docker run` 시 실행 → 스크립트 변경에 빠르게 대응

- [x] 빌드 환경 구축
  - `wasm-build/Dockerfile`: `emscripten/emsdk:3.1.46` 기반, TeX Live 2020 소스 클론
  - Phase 1 (native configure + build) 인라인 → Docker layer cache 활용
  - Phase 2 스크립트는 COPY 후 entrypoint로 실행
- [x] TeX Live 2020 소스에서 SyncTeX 포함 빌드
  - `--enable-synctex` configure 플래그
  - `synctexdir/synctex.c` 직접 컴파일 + 28개 심볼 rename (`-D` defines, BusyTeX 참조)
- [x] 2-phase 빌드 구현
  - Phase 1: native `tangle`/`otangle`로 `pdftex0.c`, `pdftexini.c`, `pdftex-pool.c`, `pdftexd.h` 생성
  - Phase 2: `emconfigure` + targeted library builds (kpathsea, zlib, libpng, xpdf) + `emcc` final link
  - `wasm-entry.c`: custom entry points (`compileLaTeX`, `compileBibtex`, `compileFormat`, `setMainEntry`)
  - `kpse-hook.c` + `library.js`: `--wrap=kpse_find_file` linker hook → JS network fallback
- [x] Worker JS (`worker-template.js`): SyncTeX 데이터 추출 포함
  - 컴파일 후 `.synctex` / `.synctex.gz` 읽어서 postMessage에 포함
  - Transferable ArrayBuffer로 zero-copy 전송
- [x] `types.ts`: `CompileResult.synctex: Uint8Array | null` 필드 추가
- [x] `swiftlatex-engine.ts`: compile() 응답에서 synctex 데이터 추출
- [x] 빌드 성공: `swiftlatexpdftex.js` (109KB) + `swiftlatexpdftex.wasm` (1.6MB)
- [x] `strings` 검증: SyncTeX 심볼 바이너리에 포함 확인
- [x] `public/swiftlatex/`에 배포

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

### D. SyncTeX 파서 + 검색 로직 ✅

참조 C 구현(`synctex_parser.c`, Jérôme Laurens) 알고리즘을 충실히 포팅한 트리 기반 파서.

- [x] `src/synctex/synctex-parser.ts`: 참조 알고리즘 포팅 (~840줄)
  - `.synctex.gz` 압축 해제: 브라우저 `DecompressionStream` API
  - Preamble 파싱: `Input:`, `Magnification:`, `Unit:`, `X Offset:`, `Y Offset:`
  - Content 파싱: `{page`, `[vbox`, `(hbox`, `hvoid`, `xkern`, `gglue`, `$math` 등 8종 노드
  - **트리 구조**: 스택 기반 파싱으로 `parent`/`children` 포인터 구축
  - **friend index**: `"tag:line"` → nodes 맵으로 O(1) forward lookup
  - 좌표 변환: TeX sp → PDF pt (`value * unit * mag / 1000 / 65536 * 72 / 72.27`)
  - **inverse search** (참조: `synctex_iterator_new_edit`):
    hbox 스캔 → smallest container → deepest container DFS → L/R bracketing → pickBestLR
  - **forward search** (참조: `synctex_iterator_new_display`):
    nearest-line zigzag (±100 tries) → non-box first pass → leaf→ancestor hbox resolution
  - **L1 (Manhattan) distance**: `hOrderedDistance`, `vOrderedDistance`, `pointNodeDistance`, `distToBox`
  - kern 노드 특수 거리 계산, 등거리 시 non-kern 우선
- [x] `SynctexData` 타입: `inputs`, `pages`, `pageRoots`, `friendIndex`
- [x] 단위 테스트: 31 tests (`src/synctex/synctex-parser.test.ts`)
  - 파싱: preamble, inputs, nodes, 다중 페이지, 빈 데이터, void/kern/glue
  - 트리 구조: parent-child 관계, friend index 내용 검증
  - Inverse search: containment, L/R bracketing, nearest fallback, 빈 페이지, 자식 노드 라인 반환
  - Forward search: 정확 매칭, 미발견 파일/라인, suffix 매칭, leaf→ancestor hbox 해소
- [x] 검증: `npx vitest run` — 76 tests pass

### E. Inverse/Forward Search UI (SyncTeX 통합) ✅

Phase 2 SyncTeX 기반으로 Phase 1 텍스트 매퍼를 fallback으로 강등.

- [x] `pdf-viewer.ts`: 클릭 핸들러 — synctex 우선, text-mapper fallback
  - `inverseLookup(synctexData, page, x/scale, y/scale)` → SourceLocation
  - synctex 실패 시 `textMapper.lookup()` fallback
- [x] `pdf-viewer.ts`: forward search — synctex 우선, text-mapper fallback
  - `forwardLookup(synctexData, file, line)` → PdfLocation
  - 하이라이트 오버레이 2초 후 페이드아웃
- [x] `main.ts`: compile 결과에서 synctex 데이터 파싱
  - `synctexParser.parse(result.synctex)` → `pdfViewer.setSynctexData()`
  - 파싱 실패 시 graceful fallback (텍스트 매퍼 사용)
- [x] TypeScript 컴파일 통과, 69 tests pass

### F. Forward Search UI (소스 커서 → PDF 하이라이트) ✅

Phase 1 텍스트 기반 forward search 구현. SyncTeX 없이도 동작.

- [x] `text-mapper.ts`: `forwardLookup(file, line)` → `PdfLocation | null`
  - `extractTextFragments()`: TeX 명령어 제거, 3+ chars 조각 추출
  - 전체 페이지 블록에서 매칭 텍스트 검색
- [x] `pdf-viewer.ts`: `forwardSearch(file, line)` 메서드
  - `textMapper.forwardLookup()` → 해당 페이지 찾기
  - 반투명 노란색 하이라이트 오버레이 (`rgba(255, 200, 0, 0.3)`)
  - 해당 페이지로 `scrollIntoView({ behavior: 'smooth', block: 'center' })`
  - 2초 후 페이드아웃 (CSS transition + setTimeout)
  - 이전 하이라이트 자동 제거
- [x] `main.ts`: Cmd/Ctrl+Enter → `pdfViewer.forwardSearch(currentFile, line)` 연결
- [x] 단위 테스트: 3 tests (forward lookup, TeX-only lines → null, unknown file → null)
- [x] 커밋: `86bd3d2`

### G. 검증 + KPI ✅

- [x] E2E 테스트: PDF Cmd+클릭 → 소스 점프 (앱 정상 동작 확인)
- [x] E2E 테스트: Cmd+Enter → PDF 하이라이트 표시 + 2초 후 페이드아웃
- [x] E2E 테스트: 다중 파일 (`\input{chapter1}`) 시 Cmd+클릭 동작
- [x] E2E 테스트: `readFile('main.log')` → TeX 로그 반환
- [x] 버그 수정: forward search 키보드 핸들러 `{ capture: true }` — Monaco보다 먼저 이벤트 처리하여 newline 삽입 방지
- [x] `window.__editor`, `window.__pdfViewer` 노출 (E2E 테스트용)
- [x] 전체 19 E2E 테스트 통과, 76 단위 테스트 통과
- [x] 참조 알고리즘 포팅 (synctex_parser.c → TypeScript): 31 parser tests pass
- [x] PDFWorker 재사용 — 편집마다 `pdf.worker.mjs` 재요청 제거
- [x] 데모 문서 업그레이드: 2단 레이아웃, 다중 페이지, 수학 섹션 6개 (SyncTeX 테스트용)
- [x] E2E 검증: SyncTeX 데이터 생성 확인 — 13 inputs, 2 pages, 1191 nodes (page 1)
- [x] 정확도 테스트: 일반 텍스트 100%, 복합 문서(2단+수식) 84% (±2줄), 수식 환경이 주 미스 원인
- [x] 성능 측정: inverse 0.02ms, forward 0.006ms (KPI 50ms 대비 **2000배+** 빠름)

### 파일 변경 (완료)

| 파일 | 작업 | 상태 |
|------|------|------|
| `wasm-build/Dockerfile` | 빌드 환경 (Emscripten + TeX Live 2020) | ✅ |
| `wasm-build/Makefile` | 2-phase 빌드 오케스트레이션 | ✅ |
| `wasm-build/build.sh` | Docker entrypoint | ✅ |
| `wasm-build/worker-template.js` | Worker JS with SyncTeX extraction | ✅ |
| `wasm-build/wasm-entry.c` | Custom WASM entry points | ✅ |
| `wasm-build/kpse-hook.c` | kpathsea → JS network fallback | ✅ |
| `wasm-build/library.js` | Emscripten JS library bridge | ✅ |
| `public/swiftlatex/swiftlatexpdftex.js` | 재빌드 (109KB) | ✅ |
| `public/swiftlatex/swiftlatexpdftex.wasm` | SyncTeX 포함 재빌드 (1.6MB) | ✅ |
| `src/synctex/synctex-parser.ts` | 참조 알고리즘 포팅 (~840줄, 트리 기반) | ✅ |
| `src/synctex/synctex-parser.test.ts` | 31 unit tests | ✅ |
| `src/synctex/text-mapper.ts` | Phase 1 텍스트 매핑 (fallback) | ✅ |
| `src/engine/swiftlatex-engine.ts` | synctex 데이터 추출 | ✅ |
| `src/types.ts` | `CompileResult.synctex` 필드 | ✅ |
| `src/viewer/pdf-viewer.ts` | synctex 기반 inverse/forward search | ✅ |
| `src/main.ts` | synctex 파싱 + fallback 통합 | ✅ |
| `src/fs/virtual-fs.ts` | 2단 다중 페이지 수학 데모 문서 | ✅ |
| `e2e/synctex-e2e.spec.ts` | SyncTeX E2E: 데이터생성/정확도/성능 (5 tests) | ✅ |

### KPI 달성 현황

| 지표 | 목표 | 실측 | 상태 |
|------|------|------|------|
| 점프 응답 시간 | < 50ms | inverse 0.02ms, forward 0.006ms | ✅ 2000배+ 초과 |
| 일반 텍스트 정확도 | 95%+ | 100% (3/3 exact) | ✅ |
| 복합 문서 정확도 | 95%+ | 90%+ (±2줄, polish 후) | ⚠️ 수식 환경 개선됨 (nearest-hbox fallback) |
| Forward search 커버리지 | — | 빈 줄도 zigzag로 해결 | ✅ |
| SyncTeX 데이터 생성 | 동작 | 13 inputs, 2 pages, 1191 nodes | ✅ |

### H. Iteration 3 Polish (완료) ✅

I3 기능 완성 후 품질 개선. 커밋 `83f3a2c`, `b4c1a08`.

- [x] **수식 환경 inverse search 개선**: nearest-hbox fallback — 정확도 84% → 90%+
- [x] **WASM 파일 경로 정규화**: `/work/./main.tex` → `main.tex` (inverse search 파일 매칭 수정)
- [x] **console.log 제거**: main.ts 7곳 + pdf-viewer.ts 4곳 (console.warn/error만 유지)
- [x] **text-mapper 중복 인덱싱 제거**: SyncTeX 있을 때 불필요한 텍스트 추출 생략
- [x] **스크롤 기반 페이지 추적**: IntersectionObserver로 현재 페이지 표시
- [ ] ~~Forward search 다중 하이라이트~~: 수식 환경의 bbox 너비 문제로 revert — 추후 재시도 필요

### 리스크 및 대안 (사후 분석)

| 리스크 | 결과 | 해결 방법 |
|--------|------|-----------|
| WEB-to-C 재생성 실패 | ✅ 해결 | 2-phase 빌드: Phase 1 native → C 생성, Phase 2 emcc 컴파일 |
| Emscripten 버전 호환 | ✅ 해결 | emsdk 3.1.46 사용 (SwiftLaTeX 원본과 다르지만 호환) |
| 포맷 파일 비호환 | ✅ 무관 | SyncTeX는 런타임 기능, 포맷 파일 변경 불필요 |
| TeX Live recursive make 실패 | ✅ 해결 | targeted library builds (kpathsea, zlib, libpng, xpdf만 빌드) |
| QEMU 에뮬레이션 느림 | ⚠️ 현재 | ARM Mac에서 x86_64 Docker: Phase 1 ~82분, Phase 2 ~30분. CI 이관 필요 |

---

## Iteration 3b — 렌더 파이프라인 리팩터링 + 체감 성능 개선 ✅

**사용자 가치:** 편집 → PDF 반영이 체감적으로 빨라짐, UI가 한 단계 세련됨

**원칙:**
1. **측정 우선 (Measure First)**: 모든 성능 최적화는 적용 전/후 벤치마크를 남긴다.
2. **추상화 우선 (Abstract First)**: 최적화 로직을 기존 코드에 직접 끼워넣지 않는다. 먼저 책임을 분리하고 인터페이스 뒤에 배치한다.
3. **복잡도 예산**: 측정 결과가 유의미하지 않으면 되돌린다.

### 완료 항목

**인프라**
- [x] `src/perf/metrics.ts`: span 기반 타이밍 수집 + `?perf=1` 디버그 오버레이
- [x] `e2e/perf-benchmark.spec.ts`: 편집→PDF 사이클 + 엔진 로드 시간 E2E 벤치마크

**렌더 파이프라인 리팩터링**
- [x] `src/viewer/page-renderer.ts`: 캔버스 렌더 책임 분리 (canvas pool: recycle/acquire)
- [x] `src/viewer/pdf-viewer.ts`: PageRenderer 위임 + 가시 페이지 우선 렌더링
- [x] IntersectionObserver 기반 스크롤 페이지 추적 + 스크롤 위치 보존

**성능 최적화**
- [x] 가시 페이지 우선 렌더링: 현재 페이지 먼저 렌더 + DOM swap → 나머지 순차
- [x] 캔버스 풀: `PageRenderer`에서 canvas 재사용 (DOM 생성 비용 절감)
- [x] 디바운스 하한 150ms → 50ms (적응형, `compileTime * 0.5`로 조절)
- [x] `CompileScheduler.flush()`: Ctrl+S로 디바운스 즉시 소화

**UX 개선**
- [x] 에디터 인라인 에러 마커: `src/ui/error-markers.ts` (Monaco `setModelMarkers`)
- [x] Ctrl/Cmd+S 즉시 컴파일 (Monaco `addAction` keybinding)
- [x] PDF 다운로드 버튼 (툴바, Blob URL)
- [x] 줌 레벨 % 표시 + 더블클릭 100% 리셋

**설계 개선**
- [x] 에러 파서: overfull/underfull box 경고 파싱 + 헬퍼 함수 추출로 복잡도 개선

### 스킵/연기 항목

- **OffscreenCanvas**: 가시 페이지 우선 렌더링으로 첫 페이지 체감이 충분히 빨라짐. 복잡도 대비 효과 부족으로 스킵. 50p+ 문서에서 재평가.
- **성능 측정/검증**: `?perf=1` 오버레이와 E2E 벤치마크가 준비됨. Docker 환경에서 실제 before/after 측정은 별도 세션에서 수행.
- **Forward search 다중 하이라이트**: 수식 환경 bbox 너비 문제로 I3 polish 때 revert. 추후 재시도.

### 결과 파일

| 파일 | 상태 |
|------|------|
| `src/perf/metrics.ts` | 신규 |
| `src/viewer/page-renderer.ts` | 신규 |
| `src/ui/error-markers.ts` | 신규 |
| `e2e/perf-benchmark.spec.ts` | 신규 |
| `src/viewer/pdf-viewer.ts` | 리팩터 (PageRenderer 위임, 가시 우선 렌더) |
| `src/engine/compile-scheduler.ts` | 확장 (flush, perf marks) |
| `src/engine/parse-errors.ts` | 확장 (box 경고, 헬퍼 추출) |
| `src/fs/virtual-fs.ts` | 확장 |
| `src/main.ts` | 통합 (마커, 단축키, PDF 다운로드) |

### KPI

| 지표 | I3b 이전 | I3b 목표 | 상태 |
|------|----------|----------|------|
| 에러 인라인 표시 | 없음 | 동작 | ✅ |
| Ctrl+S 즉시 컴파일 | 없음 | 동작 | ✅ |
| 렌더 시간 (첫 페이지) | ~184ms | < 50ms | 구현 완료, 측정 대기 |
| 편집→첫 페이지 갱신 | ~700ms | < 400ms | 구현 완료, 측정 대기 |

---

## Iteration 4 (6주) — Preamble snapshot + 컴파일 성능

**사용자 가치:** "편집할 때마다 기다리는 시간이 절반으로 줄었다"

pdfTeX WASM C 코드 수정 + Emscripten 재빌드 (I3 빌드 파이프라인 활용).

* Emscripten WASM linear memory snapshot: preamble 처리 후 `Module.HEAP` 저장 → body 편집 시 복원
* 캐시 키: preamble hash + package list
* idle time에 예열 컴파일 (speculative warm-up)
* 폰트/하이픈 패턴 로딩 캐시 강화

**KPI:** 일반 논문(10-20p) 반복 편집 시 컴파일 시간 2-5x 개선

---

## Iteration 5 (8주) — Semantic Trace + LSP

**사용자 가치:** "LaTeX가 IDE처럼 — 자동완성, 정확한 진단, go-to-definition"

pdfTeX C 코드에 semantic trace 훅 추가 (매크로 확장 시점에 이벤트 emit).

* 엔진 트레이스: labels/refs/cites/sections/includes를 구조화 이벤트로 스트리밍
* LSP 기능: cite/label 자동완성, go-to-definition, find references, 구조 outline
* 정적 파서가 아닌 엔진 실행 트레이스 기반 → LaTeX 특유의 매크로 확장도 정확하게 추적

**KPI:** 자동완성 정확도 > 95%, go-to-definition 동작

---

## Iteration 6 (10주) — PDL + LiveView: 즉시 반응

**사용자 가치:** "타이핑하면 50ms 내 페이지가 움직인다"

pdfTeX `ship_out()`에 PDL 출력 드라이버 추가. WebGPU로 PDL 렌더.

* PDL: glyph runs (font, glyph id, position) + images + vector paths + 소스 span
* WebGPU 렌더러: glyph atlas, 타일링, 뷰포트 렌더, 스크롤/줌 60fps
* "LiveView 즉시 반응" + 백그라운드 PDF 수렴 → 스왑/오버레이
* Interruptible compilation: `emscripten_sleep()` yield points (Asyncify)

**KPI:** Keystroke→화면 변화 30-80ms 달성

---

## Iteration 7 (8주) — 대형 문서 + 안정화

**사용자 가치:** "100페이지 논문도 쾌적"

* `\include` 단위 부분 컴파일: 현재 챕터만 즉시 컴파일, 전체는 백그라운드
* 또는 section 경계 체크포인트 (Preamble snapshot 확장)
* PDF.js 캐시/타일링/프리페치 강화
* arXiv급 코퍼스 회귀 테스트 파이프라인
* `tex.lock` 도입 (패키지 버전 고정 + 재현성)

**KPI:** 대형 문서 "현재 페이지" 업데이트 < 500ms, 실패율/크래시율 목표 달성

---

## Iteration 8 (4주) — 서버 fallback + 프로젝트 관리

**사용자 가치:** "어떤 패키지/문서 크기여도 일단 된다" + 폴더 구조로 실제 프로젝트 관리 가능

### A. 서버 컴파일 fallback

WASM에서 실패하거나 지원하지 않는 패키지/엔진이 필요할 때 서버로 자동 전환.

* 자동 fallback 조건: 패키지 미지원, WASM 메모리 초과, 타임버짓 초과
* Phase 1: REST API (POST source → PDF + SyncTeX + log). WebSocket 스트리밍은 이후.
* 서버 엔진: full TeX Live (pdfTeX + XeTeX + LuaTeX) — WASM이 못 하는 것을 커버
* 동일 UI/동일 기능 유지 (사용자는 로컬/서버를 의식하지 않음)

### B. 프로젝트 관리

현재: 단일 프로젝트, 플랫 파일 목록.

* 폴더 구조 지원 (VirtualFS 확장)
* 이미지/바이너리 파일 업로드 (drag & drop → engine writeFile)
* BibTeX/Biber 지원: WASM bibtex 또는 서버 fallback

**KPI:** 실패율 급감, 이미지 포함 문서 컴파일 가능, BibTeX 동작

---

## Iteration 9 (4주) — 템플릿 + 패키지 확장

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

# 8) 이 설계가 "틀 안에 갇히지 않는" 이유 (차별점)

1. **PDF를 최종 산출물로 유지하면서도**, 편집 중에는 **PDL+WebGPU로 '즉시 반응'**을 만든다.
2. LSP의 정확도를 정적 분석에 맡기지 않고, **엔진 semantic trace로 끌어올린다.**
3. VM snapshot/interruptible compilation처럼, **pdfTeX WASM을 제품 요구에 맞게 엔진 레벨로 변형**한다. (I3에서 검증된 빌드 파이프라인 활용)
4. **이원 엔진 전략**: WASM(pdfTeX, 빠르고 가벼움)으로 90%+ 커버, 서버(full TeX Live)로 100% 커버. 사용자는 차이를 의식하지 않음.
5. WebSocket fallback을 단순 백업이 아니라 **협업/빌드팜으로 확장 가능한 코어**로 설계한다.
6. whitelist를 "기술 제한"이 아니라 **프로파일/락파일/재현성**으로 제품화한다.

---

# 9) 다음 단계 (I4 착수 전 준비)

I3b 완료 기준:
- pdfTeX WASM + SyncTeX 양방향 검색 동작
- 렌더 파이프라인 리팩터링 + 체감 성능 개선 완료
- 84 단위 테스트 + 19 E2E 테스트 통과

I4 착수 전 확인 사항:
1. **Emscripten Asyncify 조사**: `emscripten_sleep()` 삽입 가능 여부, 바이너리 크기 영향 측정
2. **WASM memory snapshot PoC**: `Module.HEAP` 저장/복원 → preamble 스킵 프로토타입
3. **preamble 경계 감지**: `\begin{document}` 시점에 snapshot 트리거하는 C 코드 훅 설계
