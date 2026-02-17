# Plan

Overleaf를 월등하게 이길 수 있는 LaTeX 편집/컴파일/프리뷰 컴포넌트. 독립 제품이 아니라 **호스트 제품에 임베드**되는 구조이므로, 계정/인증/클라우드 저장/협업은 호스트 책임이고, 이 컴포넌트는 아래 네 가지에 집중한다:

* **(A) 즉시 반응하는 뷰(프리뷰 파이프라인)**
* **(B) 정확도를 수렴시키는 권위 엔진(TeX)**
* **(C) 두 세계를 연결하는 의미/좌표 매핑**
* **(D) 패키지/리소스/보안/재현성**

---

# Part I. 설계

## 1) 성공 조건 (UX KPI)

* **Keystroke → 화면 변화**: 30–80ms (P50), 150ms (P95)
* **Keystroke → 정확한 결과 수렴**: 300–1200ms (문서 크기에 따라)
* **PDF 클릭 → 소스 점프**: 50ms 이내
* **스크롤/줌 FPS**: 60fps
* **대형 문서(100p)**: 현재 페이지 200ms 내 업데이트, 전체는 비동기 수렴

## 2) 아키텍처: "권위(TeX) + 실시간(렌더러) 분리"

1. **권위 엔진(TeX)** — 정확도 보장 (pdfTeX WASM 우선, 서버 fallback)
2. **실시간 뷰** — 즉시 반응 (canvas 최적화 → 장기 WebGPU)
3. **동기화(소스↔뷰)** — SyncTeX + 엔진 트레이스

### 구성요소

* **Editor**: Monaco
* **Engine**: pdfTeX 1.40.22 WASM (SwiftLaTeX 기반, SyncTeX 포함 재빌드)
* **Fallback Server**: full TeX Live (pdfTeX + XeTeX + LuaTeX) — WASM 한계 시 자동 전환
* **Two outputs** (장기): PDF (최종/권위) + PDL (실시간 프리뷰용, pdfTeX shipout 훅)
* **Viewer**: PDF.js (현재) → WebGPU LiveView (장기)
* **Package System**: S3 + CloudFront on-demand 서빙 (전체 TeX Live)

## 3) 엔진 결정: pdfTeX WASM

Tectonic(Rust/XeTeX)과 비교 후 **pdfTeX WASM 채택**:

1. **검증된 빌드 파이프라인**: SyncTeX 28개 심볼 rename + Emscripten 재빌드 성공
2. **작은 바이너리**: 1.6MB (Tectonic은 ICU4C만으로 수 MB)
3. **이원 전략**: WASM(pdfTeX)로 90%+ 커버, 서버(full TeX Live)로 100% 커버

### pdfTeX WASM 커스터마이징 로드맵

1. **Preamble snapshot** ✅ — `\dump` primitive로 format 캐싱 → 반복 편집 ~40% 단축
2. **Interruptible compilation** — Asyncify yield points → 대형 문서 UI 블로킹 없음
3. **PDL 출력** — `ship_out()` 훅 → glyph position + font info → WebGPU 렌더러 입력
4. **Semantic Trace** ✅ — 해시 테이블 스캔 + TeX 매크로 훅 → LSP 진실 소스

## 4) 차별점

1. PDF를 최종 산출물로 유지하면서, 편집 중에는 **PDL+WebGPU로 즉시 반응**
2. LSP 정확도를 정적 분석이 아닌 **엔진 semantic trace로 끌어올림**
3. pdfTeX WASM을 **엔진 레벨로 변형** (snapshot, interruptible, PDL)
4. **이원 엔진 전략**: WASM(빠르고 가벼움) + 서버(100% 커버)
5. WebSocket fallback을 **협업/빌드팜으로 확장 가능한 코어**로 설계
6. 패키지 whitelist를 **lockfile/재현성**으로 제품화

---

# Part II. 완료 현황

| Iteration | 내용 | 핵심 성과 |
|-----------|------|-----------|
| I0 | 리스크 스파이크 | 엔진 선정, 벤치마크 PASS (컴파일 384ms, 렌더 184ms) |
| I1 | MVP | 브라우저 로컬 컴파일/뷰 동작 |
| I2 | 체감 반응성 1차 | 적응형 debounce, SW 패키지 캐시, PDF 이중 버퍼 |
| I3 | SyncTeX | WASM 재빌드 (SyncTeX 포함), 양방향 검색 (inverse 0.02ms) |
| I3b | 렌더 리팩터 + UX | 캔버스 풀, 가시 페이지 우선 렌더, Ctrl+S 즉시 컴파일 |
| I3c | CI/CD + 배포 | gh-pages 정적 배포, GitHub Actions |
| I4 | Preamble snapshot | `\dump` 기반 format 캐싱, 반복 컴파일 ~40% 단축 |
| I4b | 컴포넌트 API | `LatexEditor` 클래스, 라이브러리 빌드, 임베딩 예시 |
| I4c | 컴파일 흐름 수정 | `runMain()` 전환, WASM heap restore 버그 수정 |
| I5a | 정적 LSP | 자동완성, go-to-def, hover, outline, find references |
| I5b | Semantic Trace 1–4 | 해시 테이블 스캔 → 명령어 분류 → 인수 추출/스니펫 → 엔진 트레이스 |
| I5c | 번들 최적화 | pdftex.map gzip preload (4.6MB → 371KB) |
| I5c-d | LSP 강화 | `\cite`→`\bibitem` 점프, 계층적 outline |
| I6 | 정적 진단 | undefined ref/cite, duplicate label, 패키지 에러 파싱 |
| I6b | 멀티파일 | model-per-file, 멀티파일 SyncTeX, 크로스파일 에러/진단 |
| I6c | S3 + CloudFront | 전체 TeX Live on-demand 서빙 |
| I7a | 프로젝트 관리 | 이미지/바이너리 업로드, 폴더 구조, 트리 UI |
| I7b | BibTeX WASM | 별도 WASM 바이너리, 자동 bibtex 체인, S3에 BST 파일 |

### 코드베이스 현황

| 지표 | 수치 |
|------|------|
| TypeScript 소스 | 36 파일, ~6,500줄 |
| 단위 테스트 | 13 파일, 238 tests |
| E2E 테스트 | 8 스펙, ~1,070줄 |
| 런타임 의존성 | 2개 (monaco-editor, pdfjs-dist) |
| 정적 자산 | WASM 1.6MB + worker 119KB + .fmt 2.3MB ≈ 4MB (gzip ~2MB) |
| 배포 | https://akcorca.github.io/latex-editor/ |

---

# Part III. 로드맵

## Option E: TeX Live 2025 업그레이드

현재 WASM은 pdfTeX 1.40.22 (TeX Live 2020). 최신 패키지를 쓰려면 WASM + format + S3 패키지를 모두 업그레이드해야 한다.

* **작업:** Dockerfile 소스 변경 → kpse hook/SyncTeX 패치 호환 확인 → WASM 재빌드 → format 재생성 → S3 재업로드
* **리스크:** pdfTeX 내부 API 변경 시 패치 수정 필요
* **이점:** 최신 패키지, l3backend hack 불필요, 장기 유지보수 용이

## Iteration 7 — PDL + LiveView: 즉시 반응

**사용자 가치:** "타이핑하면 50ms 내 페이지가 움직인다"

* pdfTeX `ship_out()`에 PDL 출력 드라이버 추가
* WebGPU 렌더러: glyph atlas, 타일링, 스크롤/줌 60fps
* Interruptible compilation: `emscripten_sleep()` yield points (Asyncify)

**KPI:** Keystroke→화면 변화 30–80ms

## Iteration 8 — 대형 문서 + 안정화

**사용자 가치:** "100페이지 논문도 쾌적"

* `\include` 단위 부분 컴파일 또는 section 체크포인트
* PDF.js 캐시/타일링/프리페치 강화
* arXiv급 코퍼스 회귀 테스트
* `tex.lock` 도입 (패키지 버전 고정 + 재현성)

**KPI:** 대형 문서 현재 페이지 < 500ms

## Iteration 9 — 서버 fallback + 프로젝트 관리

**사용자 가치:** "어떤 패키지/문서여도 된다" + 실제 프로젝트 관리

### A. 서버 컴파일 fallback

* 자동 fallback: 패키지 미지원, 메모리 초과, 타임버짓 초과
* REST API (POST source → PDF + SyncTeX + log)
* 서버 엔진: full TeX Live (pdfTeX + XeTeX + LuaTeX)

### B. 프로젝트 관리 ✅

* ~~폴더 구조 지원 (VirtualFS 확장)~~ → I7a 완료
* ~~이미지/바이너리 파일 업로드 (drag & drop)~~ → I7a 완료
* ~~BibTeX 지원: WASM bibtex~~ → I7b 완료 (별도 WASM Worker, 자동 체인)

**KPI:** 이미지 포함 문서 컴파일 ✅, BibTeX 동작 ✅

## Iteration 10 — 템플릿 + 패키지 확장

**사용자 가치:** "학회 템플릿 골라서 바로 시작"

* 템플릿 갤러리 (학회/저널별 사전 구성)
* 패키지 whitelist 확장 + 의존성 그래프 도구
* 호스트 통합 인터페이스 정의

**KPI:** 템플릿 온보딩 1분 이내

---

# 호스트 제품 연동 (컴포넌트 범위 밖)

이하 기능은 호스트 제품의 책임이며, 이 컴포넌트는 API/이벤트 인터페이스만 제공한다.

* **사용자 계정 + 클라우드 저장**: 호스트가 인증/저장 담당. 컴포넌트는 `loadProject(files)` / `saveProject()` 인터페이스 노출.
* **실시간 협업**: 호스트가 CRDT/OT + WebSocket 담당. 컴포넌트는 `applyEdit(range, text)` / `onContentChange` 이벤트 인터페이스 노출.
* **권한/공유/버전 관리**: 호스트 책임.
* **Git 연동**: Git push/pull, GitHub 연동 등. 호스트가 VCS 담당. 컴포넌트는 `saveProject()` / `loadProject(files)`로 스냅샷 제공.
