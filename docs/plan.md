# Plan

Overleaf를 월등하게 이길 수 있는 논문 작성 소프트웨어. 다음 네 가지를 한 시스템으로 엮는다:

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

## 2) 제안 아키텍처: “권위(TeX) + 실시간(렌더러) 분리”가 핵심

### 큰 그림

1. **권위 엔진(TeX)**는 정확도를 보장한다. (WASM 우선, 서버 fallback)
2. **실시간 뷰**는 즉시 반응한다. (GPU/WebGPU 적극 활용)
3. **동기화(소스↔뷰)**는 SyncTeX + “더 강한 의미 트레이스”로 한다. (Tectonic 커스터마이징)

### 구성요소

* **Editor**: Monaco
* **LSP**: Rust 기반(가능하면 WASM), + 엔진 트레이스 결합
* **TTX Engine**: Tectonic 포크(대폭 커스터마이징)
* **Two outputs**

  * (1) **PDF**: 최종/권위/내보내기
  * (2) **Page Display List (PDL)**: 실시간 프리뷰용 “페이지 장면 그래프”
* **Viewer**

  * **LiveView(WebGPU)**: PDL 렌더(초저지연)
  * **PDFView(PDF.js)**: 최종 PDF 렌더(정확, 선택/검색/복사 등)
  * 두 뷰는 “스왑/오버레이” 방식으로 연결
* **Fallback Server (WebSocket)**: 패키지 미지원/문서 과대/저사양 기기에서 자동 전환
* **Package System**: whitelist + lockfile + CDN lazy fetch + 해시 검증

---

## 3) “Tectonic 대폭 커스터마이징”의 핵심 4가지

### (1) **Interruptible compilation + time-slicing**

WASM에서 “한 번 컴파일 시작하면 끝날 때까지”는 UX에 치명적입니다.

* 엔진 내부에 **안전한 yield point**를 박습니다:

  * page shipout 직후
  * paragraph 종료 지점
  * (가능하면) 일부 macro expansion 단계
* JS/worker가 **타임 버짓(예: 10–20ms)** 단위로 실행하고 yield
* 입력이 오면 즉시 cancel 가능(협조적 취소)

효과: “UI는 항상 부드럽고”, 컴파일은 뒤에서 계속 진행됩니다.

### (2) **Preamble VM Snapshot (진짜 성능 레버)**

기존의 단순 “preamble caching”보다 한 단계 더 가야 합니다.

* preamble 처리 후의 TeX VM 상태를 **스냅샷**으로 저장

  * 실무적으로는 “format dump” 또는 **WASM linear memory snapshot(페이지 단위 CoW)**가 유력
* 이후 body 편집은 스냅샷에서 시작 → preamble 재처리 제거

효과: 논문에서 반복되는 편집의 80%는 preamble 변화가 아닙니다. 여기서 압도적 이득.

### (3) **PDL(Page Display List) 출력 드라이버 추가**

“매번 PDF 만들기”가 느린 이유:

* PDF 생성 비용도 있고,
* PDF.js의 파싱/폰트 준비/렌더 준비도 큽니다.

해결:

* TeX가 shipout할 때 페이지 내용을 **PDL(장면 그래프)**로도 내보냅니다.

  * glyph runs(폰트, glyph id, 위치)
  * vector paths
  * images
  * 링크/앵커
  * 그리고 **소스 span**(파일, 라인, 컬럼, 토큰 범위)

이건 사실상 “TeX → 실시간 렌더용 IR”을 만드는 것이고, 여기서 제품의 모트가 생깁니다.

### (4) **Semantic Trace (LSP를 정적분석에만 의존하지 않게)**

LaTeX는 정적 분석이 원리적으로 한계가 있습니다. 대신:

* 엔진이 실제로 확장/실행하면서

  * label 정의
  * ref 사용
  * cite 키 사용
  * section 구조
  * include 그래프
  * 패키지 로딩
  * 에러/경고
    를 **구조화 이벤트(JSON/CBOR)**로 스트리밍

즉, LSP의 “진실”은 정적 파서가 아니라 **엔진 실행 트레이스**가 됩니다.
(이게 Overleaf+일반 에디터 조합과의 질적 차이를 만들 수 있습니다.)

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

1. **WASM SIMD + 멀티스레드(SharedArrayBuffer)**로 폰트/레이아웃/로그 처리 최적화
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

- [ ] `public/sw.js` 작성: `/texlive/` 요청 인터셉트
  - 200 응답: CacheStorage에 저장 후 반환 (cache-first)
  - 301 응답 (not found): 캐시하지 않음 (서버에 패키지 추가될 수 있음)
  - 캐시 이름에 버전 포함 (`texlive-cache-v1`)
- [ ] `main.ts`: engine init 전에 SW 등록 (`navigator.serviceWorker.register`)
- [ ] SW lifecycle 처리: install (캐시 생성), activate (구버전 캐시 정리)
- [ ] Vite dev 환경 호환: dev에서는 SW 비활성화 또는 network-first로 전환
- [ ] 단위/E2E 테스트: 두 번째 로드 시 네트워크 요청 수 감소 확인

### C. PDF 부드러운 교체 (no-flash update)

**현재:** `render()`가 `pdfDoc.destroy()` + `innerHTML = ''` 후 새 페이지 렌더 → 빈 화면 깜빡임.

- [ ] `pdf-viewer.ts`: 이중 버퍼 전략
  - 새 PDF를 DocumentFragment(오프스크린)에 렌더
  - 렌더 완료 후 `replaceChildren()`으로 한 번에 교체
  - 교체 후 이전 pdfDoc destroy
- [ ] 스크롤 위치 보존: 교체 전 `scrollTop` 저장 → 교체 후 복원
- [ ] 페이지 수 변화 대응: 페이지 추가/제거 시 스크롤 위치 클램프
- [ ] 렌더 중 재렌더 요청 처리: 새 요청이 오면 현재 렌더 취소 후 최신 데이터로 재시작

### D. 정리 + 검증

- [ ] E2E 테스트: 빠른 연속 타이핑 (50자+) → UI 끊김 없음 → 최종 PDF 정확
- [ ] E2E 테스트: 컴파일 중 타이핑 → 변경사항이 최종 PDF에 반영됨
- [ ] E2E 테스트: amsmath 사용 문서 두 번째 로드 시간 < 첫 번째 (SW 캐시)
- [ ] 콘솔 성능 측정: 편집→PDF 갱신 총 시간 로깅
- [ ] `docs/plan.md` 체크리스트 업데이트

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

* SyncTeX 생성/파싱 파이프라인
* PDF 클릭 → 소스 위치 점프
* 소스 커서 → PDF 하이라이트(Forward search)
* 오류를 소스 위치에 매핑(최소한 라인 수준)

**KPI:** 점프 50ms 내, 정확도(대부분의 텍스트) 95%+

**이 시점에 “초기 제품”으로 공개 베타가 가능**

---

## Iteration 4 (6주) — WebSocket 서버 fallback (신뢰성 확장)

**사용자 가치:** “내 논문이 어떤 패키지/문서 크기여도 일단 된다”

* 자동 fallback 조건:

  * 패키지 미지원
  * WASM 메모리 초과 위험
  * 타임버짓 초과
* WebSocket 컴파일 서비스:

  * 컴파일 로그 스트리밍
  * PDF + SyncTeX 반환
* 동일 UI/동일 기능 유지(사용자는 로컬/서버를 의식하지 않음)

**KPI:** 실패율 급감, 대형 문서 지원

---

## Iteration 5 (6주) — Profile + tex.lock + 템플릿/재현성

**사용자 가치:** “학회 템플릿 선택만 하면 바로 시작 / 결과가 항상 같음”

* Profile 시스템(학회/저널 템플릿 번들)
* `tex.lock` 도입(버전 고정)
* whitelist 확장 운영툴(내부):

  * 패키지 의존성 그래프
  * 성능/안전 등급
  * 브라우저/서버 지원 매트릭스

**KPI:** 템플릿 온보딩 1분 이내, 재현성 이슈 감소

---

## Iteration 6 (8주) — “preamble VM snapshot”로 컴파일 시간 절반 이하

**사용자 가치:** Overleaf 대비 체감 속도 우위 시작(특히 반복 편집)

* Tectonic 커스터마이징:

  * preamble 처리 후 VM 스냅샷 생성/복구
  * 캐시 키: preamble hash + profile + lockfile
* 폰트/하이픈 패턴/패키지 로딩 캐시 강화
* idle time에 “예열 컴파일”(speculative warm-up)

**KPI:** 일반 논문(10–20p)에서 2–5x 개선 목표

---

## Iteration 7 (8주) — Semantic Trace 기반 “강한 LSP”

**사용자 가치:** LaTeX가 IDE처럼 변함(자동완성/정확한 진단/리팩터)

* 엔진에서 semantic trace 스트리밍:

  * labels/refs/cites/sections/includes
* LSP 기능:

  * cite/label 자동완성(실제 문서 기반)
  * go-to-definition / find references
  * label rename(안전한 범위)
  * 구조 기반 outline, 문서 그래프

**KPI:** “정적 파서 한계”를 넘어서는 정확도(사용자가 바로 느낌)

---

## Iteration 8 (10주) — PDL + LiveView(WebGPU): 진짜 ‘즉시 반응’

**사용자 가치:** 타이핑하면 50ms 내 페이지가 움직인다(게임 체인저)

* Tectonic에 PDL 출력 드라이버 추가

  * 최소: glyph runs + 이미지 + 간단한 path
  * 소스 span 포함
* WebGPU 렌더러:

  * glyph atlas, 타일링, 뷰포트 렌더
  * 스크롤/줌 60fps 유지
* “LiveView 즉시 반응” + 백그라운드 PDF 수렴

  * 사용자는 항상 LiveView를 보고,
  * PDFView는 준비되면 스왑(또는 오버레이)

**KPI:** Keystroke→화면 변화 30–80ms 달성

---

## Iteration 9 (8주) — 대형 문서 대응: 체크포인트/부분 수렴

**사용자 가치:** 100페이지급에서도 ‘현재 작업 중인 부분’은 계속 빠름

* 엔진 체크포인트(연구 베팅):

  * section/paragraph 경계에서 상태 스냅샷(가볍게)
  * 편집 위치 근처부터 재개 시도, 실패 시 전체 fallback
* 또는 “include 단위 컴파일” 자동 지원(현실적 강수):

  * 프로젝트 구조(\include/\input) 분석
  * 현재 챕터만 즉시 컴파일, 전체는 백그라운드

**KPI:** 대형 문서에서 “현재 페이지” 업데이트 지연 상한을 낮춤

---

## Iteration 10 (8주) — PDF.js 커스터마이징: 뷰어를 ‘제품급’으로

**사용자 가치:** 뷰어가 빠르고 고급 기능(검색/복사/주석/리뷰)이 쾌적

* PDF.js 페이지 캐시/타일링/프리페치 강화
* (선택) WebGPU 백엔드 착수:

  * CanvasGraphics의 렌더 백엔드 분리
  * 텍스트/벡터 가속
* LiveView ↔ PDFView 전환 UX 최적화

  * 선택/검색은 PDFView 레이어에서
  * 즉시 반응은 LiveView에서

**KPI:** 스크롤/줌 부드러움, CPU 사용량 감소

---

## Iteration 11 (8주) — 협업/공유(Startup 성장 레버)

**사용자 가치:** 링크 공유/코멘트/공동작업이 Overleaf급 이상

* CRDT 기반 실시간 협업(문서/파일 트리)
* WebSocket 기반:

  * 공동 편집 상태 동기화
  * 서버 컴파일 스트리밍(팀 단위)
* 권한/버전/리뷰 코멘트

**KPI:** 팀 사용성 확보(유료 전환 포인트)

---

## Iteration 12 (8주) — 안정화/호환성/확장성(모트 고정)

**사용자 가치:** “이제 업무/연구에 써도 된다”

* arXiv급 코퍼스 회귀 테스트 파이프라인
* 패키지 whitelist 대폭 확대(등급제 유지)
* 관측/텔레메트리(컴파일 병목 자동 수집)
* 보안(서버 sandbox), 비용 최적화(캐시/빌드팜)

**KPI:** 실패율/크래시율 목표 달성, 장기 운영 가능

---

# 8) 이 설계가 “틀 안에 갇히지 않는” 이유 (차별점)

1. **PDF를 최종 산출물로 유지하면서도**, 편집 중에는 **PDL+WebGPU로 ‘즉시 반응’**을 만든다.
2. LSP의 정확도를 정적 분석에 맡기지 않고, **엔진 semantic trace로 끌어올린다.**
3. VM snapshot/interruptible compilation처럼, **Tectonic을 제품 요구에 맞게 엔진 레벨로 변형**한다.
4. WebSocket fallback을 단순 백업이 아니라 **스트리밍/협업/빌드팜으로 확장 가능한 코어**로 설계한다.
5. whitelist를 “기술 제한”이 아니라 **프로파일/락파일/재현성**으로 제품화한다.

---

# 9) 바로 다음 액션(팀이 당장 시작할 일)

“뛰어난 개발팀” 기준으로도 성공/실패를 가르는 건 초반 6주 리스크 제거입니다. 다음 3개 PoC를 **동시에** 돌리는 걸 권합니다.

1. **WASM 성능 PoC**: 10p/30p/100p에서 컴파일 시간/메모리/취소 지연 측정
2. **PDL PoC**: shipout hook으로 “glyph 위치 + 소스 span”을 최소 형태로 뽑아 WebGPU로 한 페이지 렌더
3. **Preamble snapshot PoC**: preamble 처리 후 상태를 재사용해 body-only 재컴파일 가능한지 확인

이 3개가 성공하면, 위 Iteration 플랜은 단순 계획이 아니라 “실행 가능한 로드맵”이 됩니다.
