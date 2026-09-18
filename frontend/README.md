# Panorama incremental — Trabalho 1 (Visão Computacional)

App Angular que funciona como uma câmera: cada foto tirada é detectada, casada com as fotos
vizinhas, alinhada por homografia robusta e integrada num mosaico que cresce em tempo real. Os
parâmetros de todas as etapas são editáveis durante a captura e o resultado é exportável como uma
única imagem PNG.

Todo o processamento é próprio (sem OpenCV): detector, descritor, casamento, RANSAC, estimativa de
focal, bundle adjustment, projeção e mistura estão implementados em TypeScript sobre `Float32Array`
e rodam num Web Worker.

## Como rodar

```bash
npm install --legacy-peer-deps      # o resolvedor de peers do npm 10 quebra na árvore do vitest
npm start                           # http://localhost:4200
npm run start:https                 # HTTPS em 0.0.0.0 — necessário para usar a câmera do celular
```

A câmera exige contexto seguro: `http://localhost` funciona, um IP de rede **não**. Pelo celular,
use `npm run start:https` e aceite o certificado. A app só consome a câmera ao vivo — não há
importação de arquivos.

```bash
npm run verify                      # 27 checagens numéricas contra ground truth sintético
npm run fakecam                     # gera /tmp/pano.y4m (varredura sintética de 72°)
npm run e2e                         # 16 checagens ponta a ponta em Chrome headless
```

## Interface

A câmera ocupa a tela inteira; tudo o mais é sobreposição.

- **Disparador** no centro inferior. À direita, **▯▯** abre a comparação entre a última foto e a
  foto com que ela foi casada, e logo abaixo **↻** reinicia o panorama depois de confirmar num
  diálogo; à esquerda, **⇄** troca de câmera (aparece só quando há mais de um dispositivo).
- **HUD (topo)** — número de fotos integradas/descartadas e o **ângulo de visão já coberto**
  (ex. `114° × 45°`), medido da caixa envolvente do mosaico na superfície escolhida.
- **Minimapa (topo, centro)** — o mosaico recortado na região coberta, atualizado a cada foto;
  toque amplia; **⬇** exporta o PNG e, ampliado, **✕** fecha.
- **Linhas só sobre a câmera** — o vídeo fica na camada mais baixa, as linhas logo acima e todos
  os controles (HUD, minimapa, disparador, botões) acima das linhas, pela escala única de
  `styles/_layers.scss`.
- **Rastreamento ao vivo** — a partir da primeira foto, o quadro atual da câmera é casado
  continuamente (a cada ~260 ms) contra as câmeras já registradas e os pares aparecem desenhados
  sobre a própria imagem: ponto **rosa** onde a característica está no panorama, ponto **amarelo**
  onde está agora e uma linha ligando os dois. A legenda diz em palavras se dá para fotografar —
  verde `sobreposição suficiente` ou vermelho `sobreposição insuficiente — volte ao enquadramento
  anterior` — com a contagem de pontos, o erro em px e contra qual foto está casando.
- **Comparação (popup)** — aberta pelo botão **▯▯**: as duas fotos lado a lado com todos os
  pares — inliers em amarelo, aceitos pelo ratio test em laranja, rejeitados tracejados — e os
  keypoints com a orientação (Etapa 3.3); **✕** ou um toque fora fecha. Nada fica sobre a câmera.
- **⚙ Parâmetros** — painel lateral com 10 controles essenciais e `mais opções` para os 26
  avançados; **✕** fecha. Mudanças em composição/global recompõem o mosaico na hora.
- **ⓘ Diagnóstico** — grafo de vizinhança (arestas do MST em destaque, intrusas tracejadas), ordem
  inferida, ângulo coberto, focal, erro de reprojeção, % de pixels inconsistentes, memória ocupada,
  acelerador em uso e custo por etapa; **✕** fecha.
- Um indicador de carregamento aparece enquanto o worker inicializa ou processa.

## Planejamento para um número ilimitado de fotos

O requisito de projeto foi: *e se as fotos nunca acabarem?* Isso descarta três coisas que aparecem
em quase toda implementação didática de panorama.

**1. Encadear homografias par a par (descartado).** Uma homografia tem 8 DoF; compor
`H₁→ₙ = Hₙ₋₁→ₙ ⋯ H₁→₂` acumula erro em escala e cisalhamento, degenera numericamente depois de
poucas dezenas de quadros e, no plano, `x = f·tan θ → ∞` perto de 90° (Aula 08, §8.2.6). Usamos o
**modelo rotacional**: cada câmera guarda `Rᵢ ∈ SO(3)` (3 DoF) com focal `f` compartilhada, e
`Hᵢⱼ = K Rᵢ Rⱼᵀ K⁻¹`. É a parametrização da Aula 08 §8.2.3: fisicamente correta para câmera que gira
no centro óptico, sem deriva de escala e válida até 360°.

**2. Casar todos os pares (descartado).** O reconhecimento de panoramas de Brown & Lowe é O(N²).
Aqui cada foto nova é casada apenas com os **k vizinhos candidatos** (padrão 5) propostos por um
índice sobre a direção do eixo óptico `Rᵀẑ` — o que torna o casamento O(1) em N e fecha laços de
360° naturalmente, porque voltar ao início reaproxima as direções. O `resolveFromScratch`
(botão *reordenar*) ainda existe e faz o O(N²) completo quando se quer provar a ordenação
automática a partir de um conjunto embaralhado.

**3. Otimizar e recompor tudo a cada foto (descartado).** Bundle adjustment global é O(N) por
iteração e recompor o mosaico é O(N·footprint) — juntos davam O(N²) e foi o que o teste de escala
mostrou primeiro (218 ms na 1ª foto → 4533 ms na 25ª). A solução tem duas partes:

- **Bundle em janela deslizante**: só as últimas `W` câmeras (padrão 6) são livres; as anteriores
  entram como âncoras fixas. Custo O(W³ + observações da janela), constante em N. Levenberg-Marquardt
  com incrementos em eixo-ângulo, focal opcionalmente livre.
- **Mosaico em dois acumuladores**: as câmeras que já saíram da janela têm pose final e são
  **comprometidas** uma única vez no acumulador `committed`; as da janela vivem num `preview`
  reconstruído a cada foto (O(W·footprint)). A renderização soma os dois acumuladores banda a banda,
  então não há emenda entre as partes.

O ponto central é que **a saída é um acumulador de tamanho fixo**, não uma lista de camadas: uma
tela na superfície escolhida (plano por padrão, cilindro ou esfera equirretangular) guardando
`Σw·I` e `Σw` por banda. A memória do mosaico depende da resolução escolhida, nunca do número de
fotos, e cada foto só toca o próprio footprint angular. Para varreduras largas troque a superfície
para cilíndrica ou esférica no painel — o plano estoura perto de 90°.

### Custo por foto (medido, `npm run verify`)

| etapa | complexidade por foto nova | medido (26 fotos, 480 px) |
|---|---|---|
| detectar + descrever | O(pixels) | 76–106 ms |
| casar | O(k · n_kp²), k ≤ 5 | 72–129 ms |
| modelo (RANSAC) | O(iter · pares) | 1–4 ms |
| bundle (janela) | O(W³ + obs) | 4–14 ms |
| compor | O(W · footprint · bandas) | 190–260 ms |
| **total** | **O(1) em N** | **350 → 470 ms, estável** |

Depois que a janela enche, o custo não cresce: 385 ms na média das fotos 8–16 contra 441 ms nas
17–26 (a variação restante é o footprint mudando de tamanho, não N).

### Armazenamento para sessões longas

Guardar cada foto como RGBA cru (960×720 = 2,7 MB) limitava a sessão. Agora, quando uma câmera sai
da janela quente (8 quadros), sua imagem de composição é **comprimida em JPEG** com
`OffscreenCanvas.convertToBlob` e o buffer cru é liberado; na recomposição o blob é decodificado sob
demanda com `createImageBitmap`. Isso troca ~2,7 MB por ~130 kB por foto:

| por foto | descritores | rotação | fonte comprimida | total |
|---|---|---|---|---|
| bytes | ≈29 kB | 72 B | ≈130 kB | **≈160 kB** |

Mil fotos ≈ 160 MB, e o número de fotos deixa de ser o limite: qualquer mudança de parâmetro
recompõe **todas** as fotos da sessão, não só as recentes. O painel ⓘ mostra a memória ocupada. Em
ambientes sem `OffscreenCanvas` (por exemplo o harness em Node) o código cai no comportamento
antigo, mantendo cru as últimas 60 fotos.

### Rastreamento ao vivo

O mesmo pipeline serve o preview: o quadro corrente é detectado/descrito e casado contra as 3
câmeras de eixo óptico mais próximo, com RANSAC, sem virar keyframe e sem tocar no mosaico. Dois
detalhes importam:

- o preview roda **na mesma resolução de análise dos keyframes** (`workWidth`). Rodar menor parecia
  uma otimização óbvia, mas BRIEF não é invariante a escala: a 384 px contra keyframes de 640 px o
  casamento caía de ~52 para ~4 inliers;
- há no máximo uma requisição de preview em voo e ela é suprimida enquanto uma captura está sendo
  processada, então o rastreamento nunca atrasa a integração de uma foto.

### Aceleração por GPU

Três etapas rodam em **WebGL2** dentro do worker, todas num único contexto compartilhado
(`vision/acceleration/gl-context.ts`):

| etapa | shader | conferência contra a CPU |
|---|---|---|
| mistura multibanda | gaussiana separável em `RGBA32F` (RGB·m e m no alfa, a convolução normalizada `Ĝ = G(m·I)/G(m)`), níveis encadeados na GPU | erro médio < 0,5 nível de cinza |
| detecção | gaussiana σ_d → Sobel → produtos `Ix², Iy², IxIy` → gaussiana σ_i → Harris / Shi-Tomasi | pico ±5 %, erro médio ≤ 1 % do pico |
| casamento | força bruta em Hamming com `popcount` em `RGBA32UI`, melhor e segundo melhor por descritor | igual bit a bit |

**Usar a GPU às cegas deixou o app mais lento**, e isso decidiu o desenho. Duas medições:

- no Chrome headless sem GPU, o WebGL cai no SwiftShader (rasterizador em CPU) e `compor` foi de
  1871 para 2655 ms; o seletor agora recusa renderizadores em software pelo nome
  (`swiftshader|llvmpipe|software|basic render`);
- mesmo com a RTX 4070 real, a primeira versão escolhia a GPU por um micro-benchmark único e
  `compor` ficou **mais lento** fim a fim (1288 ms contra 902 ms): chamadas pequenas pagam upload e
  `readPixels` síncrono, que custam mais do que a convolução economiza.

Por isso cada etapa passa por um `BackendSelector` (`backend-selector.ts`) que, na primeira vez que
é usada, **(1)** compara GPU e CPU numericamente e **(2)** mede as duas numa escada de tamanhos
(96² → 768² px no blur, 160×120 → 640×480 na detecção, 100 → 900 descritores no casamento). O
primeiro degrau em que a GPU é ≥ 15 % mais rápida vira o **limiar**; um `RoutedBackend` manda cada
chamada para a GPU só acima dele e volta para a CPU se a GPU falhar (desiste depois de 3 falhas). O
painel ⓘ mostra a decisão, ex. `webgl2 (gpu a partir de 192² px) · gpu 6.9ms vs cpu 52.9ms`, e o
toggle `GPU` nas opções avançadas desliga tudo. Os limiares são medidos em cada sessão e variam
com a carga da máquina — em execuções seguidas do E2E o casamento foi para a GPU a partir de 300 ou
de 900 descritores —, e é esse o ponto: a decisão sai da medição naquela máquina, não de uma
constante.

Resultado com a escada (`node tools/profile.mjs`, RTX 4070, 5 quadros integrados em cada modo,
média por foto):

| etapa | GPU | CPU |
|---|---|---|
| detectar (+ descrever) | 223 ms | 214 ms |
| casar | 25 ms | 41 ms |
| compor | 1218 ms | 1736 ms |

A detecção empata porque o que sobra nela é CPU — supressão não-máxima, ANMS (quadrática nos
candidatos) e amostragem do BRIEF —, não os mapas de resposta. O tempo de `compor` varia com a
área do mosaico, então compare as colunas, não com outras tabelas.

A camada de vetores desenha num canvas `desynchronized` e o vídeo e o overlay são promovidos a
camadas de composição próprias, para o navegador compor na GPU.

### Deghosting com memória limitada

Min-cut sobre todas as camadas exigiria guardar todas as camadas. A costura é calculada
incrementalmente entre o **mosaico existente** e a **foto nova**, só na faixa de sobreposição:
Dijkstra multi-fonte a partir dos núcleos exclusivos de cada lado, com custo por pixel
`1 + Δcor²`. O caminho resultante corta onde as imagens mais se parecem (Aula 08 §8.4.2). Onde a
diferença passa do limiar, o pixel é atribuído a uma única fonte em vez de misturado — é a
"detecção de pixels inconsistentes" da Etapa 6.3, e é o que impede o objeto móvel de aparecer
duplicado.

## Arquitetura

```
┌─ UI · Angular 22 standalone, zoneless, OnPush, signals ──────────────────────┐
│                                                                              │
│  camera-stage        tracks-layer        panorama-layer                      │
│  vídeo em tela       vetores ao vivo      minimapa do mosaico                │
│  cheia + disparo     sobre o quadro       + exportar PNG                     │
│                                                                              │
│  match-dialog        settings-sheet       insights-sheet                     │
│  par lado a lado     parâmetros ao vivo   grafo, ordem, métricas, custo      │
│  (popup)             confirm-dialog       por etapa · busy-veil              │
│                                                                              │
│  StitcherService · signals(params, reports, mosaic, graph, connection)       │
│  CameraService   · getUserMedia, contexto seguro, troca de dispositivo       │
└───────────────┬──────────────────────────────────────────────▲───────────────┘
                │ ImageData transferida (work 640px + compose 960px)           │
                │                                    FrameReport · MosaicPayload
                │                                    GraphPayload · Connection │
┌───────────────▼──────────────────────────────────────────────┴───────────────┐
│ Web Worker · StitchPipeline                                                  │
│                                                                              │
│   preview (≈4 Hz) ─────────────────────────────┐                             │
│                                                ▼                             │
│   image ─► detect ─────► describe ─────► match ─────► model                  │
│   cinza    Harris /      BRIEF           força bruta   DLT normalizado       │
│   gauss    Shi-Tomasi    orientado       Hamming +     + RANSAC adaptativo   │
│   sobel    FAST          256 bits        ratio test    + refit nos inliers   │
│            NMS/ANMS                      + cruzada     + checagens de sanidade│
│            sub-pixel                                          │              │
│                                                               ▼              │
│   graph ◄──── keyframes ◄──────────────────────────────── rotation           │
│   MST (Kruskal)          índice por eixo óptico          f das homografias   │
│   componentes            janela de bundle                R = K⁻¹HK → SO(3)   │
│   ordem · intrusas                                       LM em eixo-ângulo   │
│         │                                                     │              │
│         └──────────────────► project ──────► compose ◄────────┘              │
│                              esfera          warp inverso bilinear           │
│                              cilindro        costura geodésica               │
│                              plano           feather / multibanda            │
│                              (raio por       ganho por exposição             │
│                               pixel da tela) committed + preview             │
└──────────────────────────────────────────────────────────────────────────────┘
```

Fluxo de uma foto: `StitcherService.capture()` rasteriza o quadro em duas resoluções (uma para
análise, uma para composição) e transfere os buffers ao worker; o worker devolve um `FrameReport`
(keypoints, inliers, erro, ângulos, tempos), o `ConnectionPayload` com as duas imagens e as linhas
de casamento, o `MosaicPayload` já recortado e o `GraphPayload`. Nada disso passa pela thread da UI
além da escrita em `<canvas>`.

### Organização do código

Cada pasta de `src/app/vision/` corresponde a um conceito das aulas, para dar para apontar "isto é
a Aula X" em cada arquivo. `vision/` não importa nada de Angular; só `core/models` (tipos e
parâmetros) é compartilhado com a UI.

```
src/app/
├─ core/
│  ├─ models/        params · param-spec · reports · worker-protocol
│  └─ services/      CameraService · StitcherService
├─ ui/               um componente por pasta (ts/html/scss): *-layer sobre a câmera,
│                    *-sheet painel lateral, *-dialog modal
├─ workers/          stitch.worker — fila de mensagens → StitchPipeline
└─ vision/
   ├─ math/          álgebra 3×3, Jacobi, SO(3)
   ├─ imaging/       imagem, convolução, gaussiana, Sobel
   ├─ features/      tensor de estrutura, cantos, BRIEF, casamento
   ├─ geometry/      modelos de transformação, RANSAC, câmera rotacional, bundle, grafo
   ├─ compositing/   superfícies, warp, costura, exposição, horizonte, mosaico multibanda
   ├─ acceleration/  WebGL2 e seleção medida entre GPU e CPU
   └─ pipeline/      orquestração incremental
```

| pasta | classes / funções principais | conceito | aula |
|---|---|---|---|
| `math/` | `matrix3`, `decomposition` (Jacobi, sistema linear), `so3` (eixo-ângulo, rotação mais próxima) | transformações, rotações | 01 |
| `imaging/` | `toGray`, `gaussianKernel`, `blurGray`, `sobelGradients`, `blurInterleaved`, amostragem bilinear | convolução, filtro gaussiano, gradiente | 02–03 |
| `features/` | `structureTensorMaps`, `CornerDetector` (Harris / Shi-Tomasi / FAST, NMS, ANMS, sub-pixel, orientação), `BriefDescriptor`, `DescriptorMatcher` (ratio test + cruzada) | detecção, descrição e casamento de características | 05 |
| `geometry/` | `transform-model` (translação → homografia, DLT normalizado), `RansacEstimator` | transformações 2D, homografia, RANSAC | 07 |
| `geometry/` | `rotational-camera` (K, f a partir de H, H → R), `BundleAdjuster`, `PoseGraph` (MST, componentes, referência) | modelo de câmera, alinhamento global, ordem das fotos | 01, 08 |
| `compositing/` | `canvas-geometry` (plano / cilindro / esfera), `Warper`, `SeamFinder`, `ExposureCompensator`, `levelHorizon`, `Mosaic` | projeção, warp inverso, costura, compensação de exposição | 01, 08 |
| `compositing/` | `Mosaic.addBands` | pirâmide laplaciana e mistura multibanda | 02, 04, 08 |
| `acceleration/` | `GlContext`, `SeparableBlur`, `BackendSelector`, `RoutedBackend`, backends de blur / detecção / casamento | engenharia (fora das aulas) | — |
| `pipeline/` | `StitchPipeline`, `Keyframe`, `KeyframeStore`, `FeatureExtractor`, `PairLinker`, `LinkRegistry`, `CameraSolver`, `MosaicCompositor`, `LiveTracker`, `AcceleratorSuite` | fluxo do enunciado, etapas 1–6 | T1 |

`StitchPipeline.addFrame` lê como o enunciado: `features.extract` → `linkToNeighbours` (casamento
+ RANSAC contra as câmeras vizinhas) → `cameras.placeRelativeTo` → `cameras.adjust` (bundle) →
`compositor.integrate`. Cada classe de `pipeline/` tem uma responsabilidade só: `KeyframeStore`
guarda as fotos e o orçamento de memória, `PairLinker` transforma um par em aresta verificada,
`LinkRegistry` guarda as arestas e responde o grafo, `CameraSolver` guarda a focal e as rotações,
`MosaicCompositor` guarda os acumuladores e `LiveTracker` faz o casamento ao vivo.

Convenções de nome: arquivos e pastas em `kebab-case`; classes em `PascalCase` com substantivo do
papel (`CornerDetector`, `SeamFinder`); funções em `camelCase` com verbo ou quantidade calculada
(`levelHorizon`, `focalFromHomography`); tipos que atravessam o worker terminam em `Payload`
(mensagem), `Report` (relatório) ou `Record` (item de lista). A escala de `z-index` fica em
`styles/_layers.scss`.

### Matemática por etapa

- **Detecção** (Aula 05 §7.1.1, `vision/features/`) — `A = Σ w·[[Ix², IxIy],[IxIy, Iy²]]` com σ_d para a derivada e σ_i
  para a integração (σ_i > σ_d, como em Schmid et al.); `R = det(A) − α·tr(A)²` ou `min λ`
  (Shi-Tomasi); limiar relativo ao pico, NMS, ANMS para cobertura uniforme e refino sub-pixel por
  parábola.
- **Descrição e casamento** — orientação dominante por histograma de gradientes; BRIEF rodado pela
  orientação; distância de Hamming com `popcount`; ratio test `d₁/d₂ < 0,75` e checagem mútua.
- **Modelo** (Aula 07 §8.1, `vision/geometry/`) — DLT com normalização de Hartley resolvido pelo autovetor de menor
  autovalor de `AᵀA` (Jacobi); RANSAC com `N = log(1−p)/log(1−wᵏ)` adaptativo, reajuste nos inliers
  e rejeição de homografias implausíveis (determinante, escala, cisalhamento).
- **Focal e rotação** (Aula 08 §8.2.3) — com `K = diag(f,f,1)` centrada, a ortonormalidade das duas
  primeiras colunas de `R = K⁻¹HK` dá `f² = −(h₀₀h₀₁+h₁₀h₁₁)/(h₂₀h₂₁)` e
  `f² = (h₀₁²+h₁₁²−h₀₀²−h₁₀²)/(h₂₀²−h₂₁²)`; tomamos a mediana das estimativas de todos os pares. A
  matriz `K⁻¹HK` é projetada na rotação mais próxima por `R(RᵀR)^(−1/2)`.
- **Alinhamento global** (Aula 08 §8.3) — LM minimizando erro de reprojeção das correspondências
  inlier, com as observações agrupadas por par de câmeras (uma homografia por grupo, não por ponto).
- **Composição** (Aula 08 §8.4, Aula 02 §3.5.5) — cada pixel da tela gera um raio, o raio vai para a
  câmera por `R` e é amostrado bilinearmente na fonte (warp inverso, sem buracos); mistura por
  feather ou multibanda com convolução normalizada `Ĝ = G(m·I)/G(m)`; ganhos por imagem resolvidos
  em Gauss-Seidel sobre as médias de intensidade nas sobreposições.
- **Endireitamento** — vetor "para cima" como autovetor de menor autovalor da covariância dos eixos
  X das câmeras, aplicado como rotação global da tela.

## Verificação

`npm run verify` monta um mundo equirretangular procedural (hash multiescala, detalhe em qualquer
zoom), renderiza vistas com rotação conhecida e confere o pipeline contra o ground truth:

- focal a partir de H com erro < 2 % e `H → R` com desvio < 0,2°;
- 6 fotos em varredura horizontal, grade de 2 fileiras, cilíndrica+feather e planar+afim: **todas**
  integradas, focal recuperada com 0,4–2 % de erro, yaw com desvio máximo de 0,26–0,61°;
- bundle adjustment reduzindo o erro de reprojeção de 7–41 px para ~0,9 px;
- imagem intrusa de outra cena rejeitada (4–5 inliers contra ~70 dos pares válidos);
- objeto móvel detectado como pixels inconsistentes na sobreposição;
- custo por foto estável com N crescente e no máximo 5 pares avaliados por foto.

`npm run e2e` (24 checagens) sobe o Chrome headless com uma câmera falsa (`--use-file-for-fake-video-capture`
alimentado por um Y4M sintético), clica no disparador 7 vezes e confere no navegador real:
getUserMedia, acumulação no canvas, HUD com o ângulo coberto, linhas desenhadas sobre a câmera
(~50 k px pintados), rastreamento ao vivo (6/6 amostras), linhas atrás dos controles e só sobre o vídeo (ordem de
empilhamento conferida), popup de comparação aberto pelo botão (74 inliers, 88 % dos pares,
0,7 px) com o **✕** inteiro dentro do quadro, **✕** e **⬇** do minimapa ampliado sem
sobreposição, os três aceleradores em WebGL2, selects refletindo os parâmetros ativos,
recomposição ao trocar a superfície, grafo renderizado, diálogo de reinício que cancela sem apagar,
ícones centrados (desvio 0,00 px), exportação do PNG e ausência de erros de console. Capturas de
tela ficam em `/tmp/e2e`.

## Mapeamento com o enunciado

| item | onde |
|---|---|
| Etapa 1 — coleta com sobreposição e objeto móvel | captura na própria app; `npm run fakecam` gera uma cena com objeto móvel para teste |
| Etapa 2 — dois detectores comparados, escala e orientação | `detector` no painel (Harris / Shi-Tomasi / FAST); card ampliado desenha escala e orientação |
| Etapa 3 — FLANN/BF, ratio test, antes e depois | força bruta em Hamming + ratio test; vetores ao vivo sobre a câmera e card com reprovadas tracejadas |
| Etapa 4 — ordenação automática sem EXIF, matriz/grafo, intrusa rejeitada | `vision/geometry/pose-graph.ts`, overlay ⓘ, botão *reordenar* (`resolveFromScratch`) |
| Etapa 5 — homografia por RANSAC, taxa de inliers, erro de reprojeção | `vision/geometry/ransac.ts`; popup de comparação e overlay ⓘ reportam inliers, taxa e erro |
| Etapa 6 — composição, blending, deghosting | `vision/compositing/`: feather, multibanda, costura geodésica, pixels inconsistentes |
| X1 — ajuste global em vez de encadeamento | bundle adjustment em janela (`vision/geometry/bundle-adjuster.ts`) |
| X2 — 360° com projeção cilíndrica/esférica | `surface` no painel (padrão plano); cilindro cobre 360° e a esfera 360°×180° |
| X3 — compensação de exposição | ganhos por imagem estimados nas sobreposições |
| X4 — comparação com referência pronta | **não feito**: não há `cv2.Stitcher` no navegador; a comparação precisa ser externa |

## Limites conhecidos

- **Paralaxe**: o modelo rotacional pressupõe giro no centro óptico. Cenas próximas com giro fora do
  ponto nodal deixam desalinhamento que nenhum bundle resolve — a costura esconde, não corrige.
- **Sem correção de distorção radial**: o enunciado menciona (Aula 08 §8.2.1) e não implementamos;
  lentes muito grande-angulares vão casar pior nas bordas.
- **Escala**: o detector é de escala única (Harris/FAST). Aproximar ou afastar muito entre fotos
  reduz a repetibilidade; um detector DoG multiescala resolveria.
- **Sem importação de arquivos**: a app só trabalha com a câmera ao vivo; para testar sem câmera,
  use a câmera falsa do Chrome (`npm run fakecam` + `npm run e2e`).
- **Recompressão JPEG** das fontes arquivadas introduz uma perda pequena mas real na mistura de
  fotos antigas quando um parâmetro é alterado depois.
- **Custo de composição** domina (~200 ms/foto): as bandas coarse são convoluções em resolução cheia
  no tile, não uma pirâmide decimada. Uma pirâmide real ou WebGL derrubaria isso.
