# Panorama incremental — Trabalho 1 (Visão Computacional)

App Angular que funciona como uma câmera: cada foto tirada é detectada, casada com as fotos
vizinhas, alinhada por homografia robusta e integrada num mosaico que cresce em tempo real. Os
parâmetros de todas as etapas são editáveis durante a captura e o resultado é exportável como uma
única imagem PNG, composta de novo do zero na resolução nativa das fotos.

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
npm test -- --watch=false           # 90 testes unitários (Vitest), um *.spec.ts ao lado de cada etapa
npm run typecheck                   # tipos da app, do worker, dos testes e das ferramentas
npm run verify                      # 82 checagens numéricas contra ground truth sintético
npm run fakecam                     # gera /tmp/pano.y4m (varredura sintética de 72°)
npm run e2e                         # 29 checagens ponta a ponta em Chrome headless
```

## Interface

A câmera ocupa a tela inteira; tudo o mais é sobreposição.

- **Disparador** no centro inferior. À direita, **▯▯** abre a comparação entre a última foto e a
  foto com que ela foi casada, e logo abaixo **↻** reinicia o panorama depois de confirmar num
  diálogo; à esquerda, **⇄** troca de câmera (aparece só quando há mais de um dispositivo).
- **HUD (topo)** — número de fotos integradas/descartadas. O **ângulo de visão já coberto**
  (ex. `114° × 45°`, medido da caixa envolvente do mosaico na superfície escolhida) fica no painel
  de diagnóstico ⓘ.
- **Minimapa (topo, centro)** — o mosaico recortado na região coberta, atualizado a cada foto;
  toque amplia; **⬇** exporta o PNG e, ampliado, **✕** fecha. Um selo diz o tempo todo que aquilo é
  uma **prévia** (`PREVIEW`); enquanto o worker compõe, o selo vira `COMPOSITING` com um spinner e o
  **⬇** fica bloqueado — só dá para exportar quando a composição terminou.
- **Linhas só sobre a câmera** — o vídeo fica na camada mais baixa, as linhas logo acima e todos
  os controles (HUD, minimapa, disparador, botões) acima das linhas, pela escala única de
  `styles/_layers.scss`.
- **Rastreamento ao vivo** — a partir da primeira foto, o quadro atual da câmera é casado
  continuamente (a cada quadro novo da câmera, até onde o worker acompanha) contra as câmeras já
  registradas e os pares aparecem desenhados
  sobre a própria imagem: ponto **rosa** onde a característica está no panorama, ponto **amarelo**
  onde está agora e uma linha ligando os dois. A legenda diz em palavras se dá para fotografar —
  verde `ready to shoot` ou vermelho `not enough overlap` — com a contagem de pontos, o erro em px
  e contra qual foto está casando.
- **Comparação (popup)** — aberta pelo botão **▯▯**: as duas fotos lado a lado com todos os
  pares — inliers em amarelo, aceitos pelo ratio test em laranja, rejeitados tracejados — e os
  keypoints com a orientação (Etapa 3.3); **✕** ou um toque fora fecha. Nada fica sobre a câmera.
- **⚙ Parâmetros** — painel lateral com os controles essenciais e `more options` para os 29
  avançados; **✕** fecha. Mudanças em composição/global recompõem o mosaico na hora.
- **ⓘ Diagnóstico** — grafo de vizinhança (arestas do MST em destaque, intrusas tracejadas), ordem
  inferida, ângulo coberto, focal, distorção da lente κ₁, vinheta β, erro de reprojeção, % de
  pixels inconsistentes, memória ocupada, acelerador de cada etapa e custo por etapa; **✕** fecha.
- Um indicador de carregamento mostra a etapa e o progresso (ex. `rendering export 63%`) sempre que
  o worker inicializa, integra uma foto, recompõe, refina o alinhamento ou exporta.

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
mostrou primeiro (218 ms na 1ª foto → 4533 ms na 25ª). A solução separa o que precisa ser rápido
(capturar) do que precisa ser exato (a imagem final):

- **Bundle em janela deslizante durante a captura**: só as últimas `W` câmeras (padrão 6) são
  livres; as anteriores entram como âncoras fixas. Custo O(W³ + observações da janela), constante
  em N.
- **Refino global quando a app fica ociosa**: ~0,4 s depois da última requisição o worker roda o
  bundle adjustment com **todas** as câmeras livres (o alinhamento global de Brown & Lowe, que
  elimina a deriva que a janela não enxerga) e, se alguma pose, focal, ganho, κ₁ ou β mudou o
  suficiente para aparecer, recompõe a prévia. Uma nova foto cancela esse passo.
- **Prévia em dois acumuladores**: as câmeras que já saíram da janela são **comprometidas** uma
  única vez no acumulador `committed`; as 3 mais recentes vivem num `preview` redesenhado a cada
  foto. A renderização soma os dois acumuladores banda a banda, então não há emenda entre as partes.
- **Exportação separada da prévia**: o PNG nunca é a prévia. Ele é composto de novo do zero, com
  todas as fotos e as poses finais, numa tela recortada na região coberta e amostrada na resolução
  nativa das fotos (veja *Exportação*).

O ponto central é que **a prévia é um acumulador de tamanho fixo**, não uma lista de camadas: uma
tela na superfície escolhida (plano por padrão, cilindro ou esfera equirretangular) guardando
`Σw·I` e `Σw` por banda da pirâmide. A memória da prévia depende da resolução escolhida, nunca do
número de fotos, e cada foto só toca o próprio footprint angular. Para varreduras largas troque a
superfície para cilíndrica ou esférica no painel — o plano estoura perto de 90°.

### Custo por foto (medido, `node tools/profile.mjs`, RTX 4070)

| etapa | complexidade por foto nova | GPU | CPU |
|---|---|---|---|
| detectar (3 escalas) | O(pixels) | 145 ms | 152 ms |
| casar | O(k · n_kp²), k ≤ 5 | 32 ms | 63 ms |
| bundle (janela) | O(W³ + obs) | 26 ms | 20 ms |
| compor a prévia | O(3 · footprint) | 269 ms | 433 ms |

O custo não cresce com N depois que a janela enche. O refino global e a recomposição completa da
prévia acontecem fora da captura, no tempo ocioso.

### Exportação

A prévia usa uma tela de 360° com `canvasWidth` px (1792 por padrão), então um panorama de 100°
ocupa só ~500 px dela. Exportar essa tela era o motivo do PNG sair borrado. A exportação é um
passo à parte (`vision/compositing/export/panorama-exporter.ts`), no mesmo desenho de resoluções do
`stitching_detailed` do OpenCV:

1. **escala nativa** — a tela é escolhida para amostrar as fotos na resolução delas: `2π·f` px por
   volta no cilindro/esfera e `2,4·f` no plano, com `f` a focal na resolução de composição; a união
   dos footprints de todas as fotos é calculada **antes** de alocar qualquer coisa;
2. **costuras globais em baixa resolução** — todas as fotos são projetadas numa tela de ~2 MP e a
   costura geodésica roda uma vez, na ordem de composição; a máscara final de cada foto (rampa +
   costura) é guardada. Assim a decisão de "qual foto vale onde" é uma só para a imagem inteira;
3. **ladrilhos em resolução cheia** — a saída é dividida em ladrilhos de 1024 px com **halo** de
   128 px (maior que o suporte da pirâmide). Cada ladrilho compõe só as fotos cujo footprint o toca,
   com a máscara global ampliada bilinearmente, na GPU quando disponível, e só o miolo é mantido;
4. **PNG em fluxo** — ao fim de cada faixa de ladrilhos as linhas vão para um codificador PNG
   próprio no worker (`vision/compositing/export/png-writer.ts`: filtro Paeth, `CompressionStream('deflate')`,
   CRC dos chunks). A imagem inteira nunca existe num buffer nem num `<canvas>`, então os limites
   de área de canvas dos navegadores (16,7 MP no Safari do iOS) não se aplicam.

O ladrilhamento é conferido: com ladrilhos de 256 px a exportação sai **idêntica bit a bit** à de
um ladrilho único. Uma volta completa de 360° com 24 fotos de 1600×1200 sai em 12288×1536
(18,9 MP, PNG de 34 MB) em 24 s no caminho CPU, e a emenda em 0°/360° é contínua (diferença entre a
última e a primeira coluna igual à de colunas vizinhas quaisquer).

`exportScale` (fração da resolução nativa, padrão 1) e `exportMegapixels` (teto do arquivo, padrão
120 MP) ficam nas opções avançadas.

### Armazenamento para sessões longas

Guardar cada foto como RGBA cru (1600×1200 = 7,7 MB na resolução de composição padrão) limitava a
sessão. Quando uma câmera sai da janela quente (8 quadros), sua imagem de composição é **comprimida
em JPEG** (qualidade 0,94) com `OffscreenCanvas.convertToBlob` e o buffer cru é liberado; na
recomposição o blob é decodificado sob demanda com `createImageBitmap`. Isso troca ~7,7 MB por
~0,4 MB por foto, e o número de fotos deixa de ser o limite: qualquer mudança de parâmetro
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
  processada, então o rastreamento nunca atrasa a integração de uma foto. Assim que a resposta
  chega, o próximo quadro novo da câmera já é enviado (laço por `requestAnimationFrame`, um canvas
  reaproveitado): ~24 atualizações/s com uma câmera de 30 fps;
- o preview pode **cortar caminho**, a foto final não: o casamento ao vivo pula a checagem cruzada,
  tenta primeiro a câmera que casou no quadro anterior e para na primeira verificada. As capturas
  usam o pipeline completo.

### Aceleração por GPU

Cinco etapas rodam em **WebGL2** dentro do worker, todas num único contexto compartilhado
(`vision/foundation/gpu/gl-context.ts`); o backend de cada etapa mora na pasta da própria etapa:

| etapa | shader | conferência contra a CPU |
|---|---|---|
| warp | raio da tela → câmera → distorção κ₁ → amostragem com **mipmaps** (trilinear) → ganho e vinheta; saída RGBA8 | erro médio < 1,5 nível de cinza, máscara < 0,02 |
| mosaico | acumuladores em texturas `RGBA32F` com mistura aditiva (`EXT_float_blend`): redução da pirâmide, bandas laplacianas acumuladas na resolução de cada nível, reconstrução, amostras para a costura | renders e amostras iguais à CPU (média < 0,75, máximo ≤ 6), inclusive numa janela que cruza a emenda de 360° |
| pirâmide da mistura | redução binomial 5×5 com decimação por 2 em `RGBA32F` (cor·m e m), `texelFetch` | erro médio < 0,75 |
| detecção | gaussiana σ_d → Sobel → produtos `Ix², Iy², IxIy` → gaussiana σ_i → Harris / Shi-Tomasi | pico ±5 %, erro médio ≤ 1 % do pico |
| casamento | força bruta em Hamming com `popcount` em `RGBA32UI`, melhor e segundo melhor por descritor | igual bit a bit |

**Usar a GPU às cegas deixou o app mais lento**, e isso decidiu o desenho. Duas medições:

- no Chrome headless sem GPU, o WebGL cai no SwiftShader (rasterizador em CPU) e `compor` foi de
  1871 para 2655 ms; o seletor agora recusa renderizadores em software pelo nome
  (`swiftshader|llvmpipe|software|basic render`);
- mesmo com a RTX 4070 real, a primeira versão escolhia a GPU por um micro-benchmark único e
  `compor` ficou **mais lento** fim a fim (1288 ms contra 902 ms): chamadas pequenas pagam upload e
  `readPixels` síncrono, que custam mais do que a convolução economiza.

Por isso cada etapa passa por um `BackendSelector` (`backend-selector.ts`) que **(1)** compara GPU e
CPU numericamente e **(2)** mede as duas numa escada de tamanhos. O primeiro degrau em que a GPU é
≥ 15 % mais rápida vira o **limiar**; um `RoutedBackend` manda cada chamada para a GPU só acima dele
e volta para a CPU se a GPU falhar (desiste depois de 3 falhas). A calibração roda quando o worker
sobe, antes de ele se declarar pronto, então não pesa na primeira foto. O painel ⓘ mostra a
decisão, ex. `webgl2 (gpu from 256² px) · gpu 7.0ms vs cpu 38.6ms`, e o toggle `GPU` nas opções
avançadas desliga tudo.

Dois cuidados deixam o warp barato na GPU: a textura da fonte (com mipmaps) fica em cache enquanto
a mesma foto é redesenhada, e a leitura volta em 8 bits (a fonte já é 8 bits), o que corta 4× o
`readPixels` em relação a float e dispensa `EXT_color_buffer_float` — mais celulares ficam com o
warp na GPU.

O mosaico inteiro da prévia fica na GPU: a CPU só calcula a costura (Dijkstra numa grade reduzida,
sequencial por natureza) e a cobertura. Na calibração a GPU compõe 5× mais rápido que a CPU
(52 ms contra 262 ms). Dois achados do perfilador de CPU do worker (CDP `Profiler` anexado ao
alvo do worker) mudaram o desenho:

- **Realocar alvos custava mais que desenhar**: cada tamanho novo de ladrilho ou de nível da
  pirâmide criava um framebuffer, e `checkFramebufferStatus` sincroniza CPU e GPU (3,2 s em 8
  fotos). Os alvos agora só crescem (em passos de 128 px, compartilhados entre mosaicos), os
  shaders endereçam por `texelFetch` com tamanho lógico, e a detecção guarda alocações por tamanho
  de imagem — caiu para 0,12 s. A detecção também devolve gradiente e resposta numa leitura só;
- **O rastreamento ao vivo ocupava metade do worker**: a extração a cada 260 ms somava 6 s em 18 s.
  A prévia usa só o nível 0 da pirâmide, casa sem checagem cruzada contra uma câmera por vez, o
  RANSAC para em C(n, 4)·3 amostras quando há poucos pares, a amostra mínima de 4 pontos é
  resolvida por um sistema 8×8 exato (o ajuste final nos inliers segue no DLT normalizado com
  Jacobi) e a NMS testa só a janela dos pixels acima do limiar.

A camada de vetores desenha num canvas `desynchronized` e o vídeo e o overlay são promovidos a
camadas de composição próprias, para o navegador compor na GPU.

### Deghosting com memória limitada

Min-cut sobre todas as camadas exigiria guardar todas as camadas. A costura é calculada
incrementalmente entre o **mosaico existente** e a **foto nova**, só na faixa de sobreposição:
Dijkstra multi-fonte a partir dos núcleos exclusivos de cada lado, com custo por pixel
`1 + Δcor²`. Como no OpenCV (`seam_megapix`), a busca roda numa grade reduzida (`seamMegapixels`,
0,2 MP por padrão; 0 busca na resolução cheia) e o rótulo é levado de volta a cada pixel. O caminho resultante corta onde as imagens mais se parecem (Aula 08 §8.4.2). Onde a
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
                │ ImageData transferida (work 640px + compose 1600px)          │
                │                                    FrameReport · MosaicPayload
                │                                    GraphPayload · Connection │
┌───────────────▼──────────────────────────────────────────────┴───────────────┐
│ Web Worker · StitchPipeline                                                  │
│                                                                              │
│   preview (cada quadro) ───────────────────────┐                             │
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
│   componentes            bundle em janela               R = K⁻¹HK → SO(3)   │
│   ordem · intrusas       + global quando ocioso          LM · Huber · κ₁     │
│         │                                                     │              │
│         └──────────────────► project ──────► compose ◄────────┘              │
│                              esfera          warp inverso com mipmaps        │
│                              cilindro        costura geodésica               │
│                              plano           feather / pirâmide laplaciana   │
│                              (raio por       ganho + vinheta                 │
│                               pixel da tela) prévia · exportação nativa      │
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
├─ core/                      estado global da app e ponte com o worker
│  ├─ models/                 params · param-spec · reports · worker-protocol
│  ├─ services/               CameraService · StitcherService
│  └─ workers/                stitch.worker — fila de mensagens → StitchPipeline
├─ ui/                        um componente por pasta (ts/html/scss): *-layer sobre a câmera,
│                             *-sheet painel lateral, *-dialog modal
└─ vision/                    algoritmos, sem Angular
   ├─ foundation/             base usada por todas as etapas
   │  ├─ math/                matrizes 3×3, rotações, Jacobi, eliminação gaussiana, Cholesky
   │  ├─ imaging/             imagem, filtro gaussiano, Sobel, pirâmide de cinza
   │  └─ gpu/                 contexto WebGL2 e seleção medida entre GPU e CPU
   ├─ features/               características (Aula 05)
   │  ├─ detection/           tensor de estrutura, Harris, Shi-Tomasi, FAST, NMS, ANMS, sub-pixel
   │  ├─ description/         orientação dominante, BRIEF
   │  └─ matching/            Hamming, ratio test + checagem cruzada
   ├─ registration/           alinhamento geométrico (Aulas 07–08)
   │  ├─ estimation/          Hartley, DLT, afim, similaridade, translação, erro de transferência, RANSAC
   │  └─ alignment/           câmera rotacional, lente κ₁, bundle adjustment, grafo, horizonte
   ├─ compositing/            composição (Aula 08)
   │  ├─ warping/             plano / cilindro / esfera, pegadas, mipmaps, warp inverso
   │  ├─ photometric/         compensação de exposição, vinheta
   │  ├─ seams/               costura
   │  ├─ blending/            pirâmide gaussiana/laplaciana, mosaico multibanda (CPU e GPU)
   │  └─ export/              exportação em blocos e PNG
   └─ pipeline/               orquestração incremental das etapas acima
```

`vision/` tem um nível por fase do fluxo (base → características → registro → composição) e, dentro
de cada fase, uma pasta por etapa das aulas, e cada método tem seu arquivo, com o nome do método ou da
classe que ele implementa (`harris.ts`, `fit-homography.ts`, `bundle-adjuster.ts`). Quando uma
etapa roda na GPU, o backend fica na pasta da etapa (`detection/detect-backend.ts`,
`matching/match-backend.ts`, `warping/warp-backend.ts`, `blending/gpu-mosaic.ts`); só a
infraestrutura WebGL2 compartilhada fica em `foundation/gpu/`.

| pasta | arquivos (um método cada) | conceito | aula |
|---|---|---|---|
| `foundation/math/` | `matrix3`, `rotation` (Rodrigues, rotação mais próxima, eixo óptico), `jacobi-eigen`, `gaussian-elimination`, `cholesky`, `median` | transformações, rotações, álgebra linear | 01 |
| `foundation/imaging/` | `image` (`toGray`, centro óptico), `bilinear`, `gaussian-blur`, `sobel-gradients`, `gray-pyramid` | convolução, filtro gaussiano, gradiente, pirâmide de escalas | 02–05 |
| `foundation/gpu/` | `gl-context`, `separable-blur`, `backend-selector`, `accelerator-suite` | engenharia (fora das aulas) | — |
| `features/detection/` | `structure-tensor`, `harris`, `shi-tomasi`, `fast-segment-test`, `non-maximum-suppression`, `adaptive-suppression` (SSC), `sub-pixel-refinement`, `corner-detector` | detecção de cantos | 05 |
| `features/description/` | `dominant-orientation`, `brief-descriptor` | descritores binários invariantes à rotação | 05 |
| `features/matching/` | `hamming-distance`, `descriptor-matcher` (ratio test + cruzada) | casamento de características | 05 |
| `registration/estimation/` | `correspondence`, `hartley-normalization`, `fit-homography` (DLT), `fit-affine`, `fit-similarity`, `fit-translation`, `fit-model`, `transfer-error`, `ransac-estimator` | transformações 2D, homografia, RANSAC | 07 |
| `registration/alignment/` | `rotational-camera` (K, f a partir de H, H → R), `lens-distortion` (κ₁), `bundle-adjuster`, `pose-graph` (MST, componentes, referência), `level-horizon` | modelo de câmera, distorção radial, alinhamento global, ordem das fotos, endireitamento | 01, 08 |
| `compositing/warping/` | `canvas-geometry` (plano / cilindro / esfera), `canvas-box`, `footprint`, `canvas-transfer`, `mip-pyramid`, `warper`, `warp-tile` | projeção, warp inverso com pré-filtro | 01, 04, 08 |
| `compositing/photometric/` | `exposure-compensator`, `vignetting` | compensação de ganho e de vinheta | 08 |
| `compositing/seams/` | `seam-finder` | costura de menor custo | 08 |
| `compositing/blending/` | `gaussian-pyramid`, `mosaic-surface`, `mosaic-grid` (janela, emenda de 360°, cobertura), `cpu-mosaic`, `gpu-mosaic` | pirâmide gaussiana/laplaciana e mistura multibanda | 02, 04, 08 |
| `compositing/export/` | `panorama-exporter`, `png-writer` | exportação em resolução cheia | — |
| `pipeline/` | `StitchPipeline`, `Keyframe`, `KeyframeStore`, `FeatureExtractor`, `PairLinker`, `LinkRegistry`, `CameraSolver`, `PhotometricCalibrator`, `MosaicCompositor`, `LiveTracker` | fluxo do enunciado, etapas 1–6 | T1 |

### Responsabilidade de cada arquivo

Cada arquivo tem uma responsabilidade só; o nome do arquivo é o do método ou da classe principal.

**core/** — estado da app e ponte com o worker
- `models/params.ts` — parâmetros do pipeline, valores padrão e leitura/escrita por grupo e chave.
- `models/param-spec.ts` — rótulo, dica e faixa de cada parâmetro exposto no painel.
- `models/reports.ts` — formato dos relatórios e cargas que o worker manda para a UI.
- `models/worker-protocol.ts` — mensagens trocadas entre serviço e worker.
- `services/camera-service.ts` — abre, troca e fecha a câmera (getUserMedia, novas tentativas).
- `services/stitcher-service.ts` — fala com o worker: capturas, prévias ao vivo, exportação, estado em signals.
- `workers/stitch.worker.ts` — fila de mensagens do worker, refino ocioso e exportação.

**ui/** — um componente por pasta
- `camera-stage` — vídeo, HUD, disparador e botões; `tracks-layer` — linhas de casamento sobre o vídeo;
  `panorama-layer` — minimapa e exportação; `settings-sheet` — parâmetros; `insights-sheet` —
  diagnóstico, grafo e custos; `match-dialog` — comparação lado a lado; `confirm-dialog` — confirmação
  genérica; `busy-veil` — indicador de trabalho; `shared/paint-raster.ts` — pinta pixels num canvas.

**vision/foundation/** — base usada por todas as etapas
- `math/matrix3.ts` — álgebra de matrizes 3×3; `rotation.ts` — rotações (Rodrigues, rotação mais próxima,
  ângulo entre rotações, eixo óptico, yaw/pitch); `jacobi-eigen.ts` — autovalores de matriz simétrica;
  `gaussian-elimination.ts` — sistema linear com pivoteamento; `cholesky.ts` — sistema simétrico
  definido positivo; `median.ts` — mediana; `angles.ts` — radianos para graus.
- `cache/lru-cache.ts` — cache LRU com aviso de descarte (texturas da detecção, fotos da exportação).
- `imaging/image.ts` — tipos de imagem, luminância (`luma`) e centro óptico; `bilinear.ts` — interpolação
  bilinear para qualquer número de canais; `gaussian-blur.ts` — filtro gaussiano separável;
  `sobel-gradients.ts` — gradiente de Sobel; `gray-pyramid.ts` — pirâmide de escalas para detecção.
- `gpu/gl-context.ts` — contexto WebGL2 compartilhado, programas e alvos; `separable-blur.ts` —
  gaussiana na GPU; `backend-selector.ts` — calibra GPU contra CPU e escolhe; `accelerator-suite.ts`
  — agrupa os seletores de cada etapa.

**vision/features/** — características
- `detection/structure-tensor.ts` — tensor de estrutura e mapa de resposta; `harris.ts`,
  `shi-tomasi.ts` — as duas medidas de canto; `fast-segment-test.ts` — teste de segmento FAST;
  `non-maximum-suppression.ts` — máximos locais; `sub-pixel-refinement.ts` — vértice da quadrática;
  `adaptive-suppression.ts` — ANMS (SSC); `corner-detector.ts` — encadeia as etapas acima;
  `detect-backend.ts` — mesma detecção na GPU; `keypoint.ts` — tipo do ponto.
- `description/dominant-orientation.ts` — orientação por histograma de gradientes;
  `brief-descriptor.ts` — BRIEF rodado pela orientação.
- `matching/hamming-distance.ts` — distância de Hamming; `descriptor-matcher.ts` — vizinho mais
  próximo, ratio test e checagem cruzada; `match-backend.ts` — busca de vizinhos na GPU.

**vision/registration/** — alinhamento geométrico
- `estimation/correspondence.ts` — par de pontos, escala de localização e peso; `hartley-normalization.ts`
  — normalização de Hartley; `fit-homography.ts` — DLT (mínimo exato e mínimos quadrados ponderados);
  `fit-affine.ts`, `fit-similarity.ts`, `fit-translation.ts` — os outros modelos; `fit-model.ts` —
  escolhe o modelo e rejeita homografias implausíveis; `transfer-error.ts` — erro de transferência
  simples e simétrico; `ransac-estimator.ts` — RANSAC adaptativo com reajuste iterado.
- `alignment/rotational-camera.ts` — focal e rotação a partir de H; `lens-distortion.ts` — modelo κ₁;
  `bundle-adjuster.ts` — Levenberg-Marquardt esparso; `pose-graph.ts` — árvore geradora, componentes e
  referência; `level-horizon.ts` — endireitamento.

**vision/compositing/** — composição
- `warping/canvas-geometry.ts` — superfícies plano/cilindro/esfera; `canvas-box.ts` — caixas e
  alinhamento à pirâmide; `footprint.ts` — região de cada foto na tela (incluindo polos e a emenda de
  360°); `canvas-transfer.ts` — mudança de resolução da tela; `mip-pyramid.ts` — mipmaps e amostragem
  trilinear; `warper.ts` — recorta a região e chama o backend; `warp-backend.ts` — warp inverso em CPU e
  GPU; `warp-tile.ts` — tipo do bloco.
- `photometric/exposure-compensator.ts` — ganhos de exposição; `vignetting.ts` — modelo e estimativa de
  vinheta.
- `seams/seam-finder.ts` — costura de menor custo e rampa a partir dela.
- `blending/gaussian-pyramid.ts` — reduzir/expandir; `mosaic-surface.ts` — contrato de um mosaico;
  `mosaic-grid.ts` — janela na tela, emenda de 360°, cobertura e retratos; `cpu-mosaic.ts`,
  `gpu-mosaic.ts` — acumuladores multibanda e planos; `blend-tile.ts` — soma um bloco conforme o
  modo de mistura; `blur-backend.ts` — pirâmide na GPU; `mosaic-backend.ts` — calibração do mosaico
  de GPU para o `BackendSelector`.
- `export/panorama-exporter.ts` — exportação em blocos com costura global; `png-writer.ts` — PNG em fluxo.

**vision/pipeline/** — orquestração
- `stitch-pipeline.ts` — fluxo por foto, refino ocioso e reordenação; `keyframe.ts` — uma foto e suas
  imagens; `keyframe-store.ts` — fotos e orçamento de memória; `feature-extractor.ts` — detecção e
  descrição multiescala; `pair-linker.ts` — transforma um par em ligação verificada; `pair-link.ts` —
  tipo da ligação; `link-registry.ts` — ligações e grafo; `camera-solver.ts` — focal, distorção e
  bundle; `photometric-calibrator.ts` — vinheta e ganhos a partir das ligações; `mosaic-compositor.ts`
  — mosaicos, prévia e decisão de recompor; `live-tracker.ts` — casamento ao vivo.

**tools/** — `verify.ts` (checagens numéricas), `e2e.mjs` (navegador real), `profile.mjs` (custo por
etapa), `devtools.mjs` (Chrome headless compartilhado; `tsconfig.tools.json` confere os tipos), `scene.ts` (cena sintética), `fakecam.ts`
(vídeo da câmera falsa), `polyfill.mjs` (`ImageData` no Node).

`StitchPipeline.addFrame` lê como o enunciado: `features.extract` → `linkToNeighbours` (casamento
+ RANSAC contra as câmeras vizinhas) → `cameras.placeRelativeTo` → `cameras.adjust` (bundle) →
`compositor.integrate`. Cada classe de `pipeline/` tem uma responsabilidade só: `KeyframeStore`
guarda as fotos e o orçamento de memória, `PairLinker` transforma um par em aresta verificada,
`LinkRegistry` guarda as arestas e responde o grafo, `CameraSolver` guarda a focal e as rotações,
`MosaicCompositor` guarda os acumuladores e `LiveTracker` faz o casamento ao vivo.

Convenções de nome: arquivos e pastas em `kebab-case`, com o nome do método ou da classe principal
(`CornerDetector` → `corner-detector.ts`, `CameraService` → `camera-service.ts`; só o worker mantém
o sufixo `.worker.ts` exigido pelo build); classes em `PascalCase` com substantivo do
papel (`CornerDetector`, `SeamFinder`); funções em `camelCase` com verbo ou quantidade calculada
(`levelHorizon`, `focalFromHomography`); tipos que atravessam o worker terminam em `Payload`
(mensagem), `Report` (relatório) ou `Record` (item de lista). A escala de `z-index` fica em
`styles/_layers.scss`.

### Matemática por etapa

- **Detecção** (Aula 05 §7.1.1, `vision/features/detection/`) — `A = Σ w·[[Ix², IxIy],[IxIy, Iy²]]` com σ_d
  para a derivada e σ_i para a integração (σ_i > σ_d, como em Schmid et al.); `R = det(A) − α·tr(A)²`
  ou `min λ` (Shi-Tomasi); limiar relativo ao pico; NMS por dilatação separável (máximo em janela
  `(2r+1)²` em O(r) por pixel); ANMS por cobertura de quadrados (SSC, Bailo et al. 2018) (grade de lado
  `r/√2`, então cada célula guarda no máximo um ponto) e busca binária do **maior** raio que ainda
  mantém a cota de pontos, O(n log n) em vez de O(n²); refino sub-pixel ajustando a **quadrática 2D
  completa** (com o termo cruzado `∂²R/∂x∂y`) e tomando o vértice.
- **Multiescala** (Aula 05 §7.1.1, "procurar cantos em todas as escalas"; desenho do ORB) — pirâmide
  de 3 níveis com razão 1,5, cada nível pré-filtrado antes de reduzir (Aula 04); o mesmo detector
  roda em todos os níveis com cotas de pontos proporcionais à área do nível, o BRIEF é amostrado no
  nível do ponto (janela normalizada pela escala) e cada ponto volta à resolução cheia com sua
  escala. Sob zoom de 1,6× entre duas vistas, o casamento vai de 4 inliers (escala única) para 76, e
  a escala recuperada é 1,601. No bundle cada resíduo é dividido pela escala do ponto medido
  (peso `1/s²`, a "incerteza do ponto" da Aula 07 §8.1.1).
- **Descrição e casamento** — orientação dominante por histograma de gradientes; BRIEF rodado pela
  orientação; distância de Hamming com `popcount`; ratio test `d₁/d₂ < 0,75` e checagem mútua.
- **Modelo** (Aula 07 §8.1, `vision/registration/estimation/`) — DLT com normalização de Hartley resolvido pelo
  autovetor de menor autovalor de `AᵀA` (Jacobi); RANSAC com `N = log(1−p)/log(1−wᵏ)` adaptativo,
  **erro de transferência simétrico** `√((d(Hx,x')² + d(H⁻¹x',x)²)/2)` (Hartley & Zisserman) e rejeição
  de homografias implausíveis (determinante, escala, cisalhamento). O limiar (2,5 px) vale para pontos
  da resolução cheia e é multiplicado pela escala de pirâmide de cada par, porque o erro de
  localização cresce com ela (p95 medido: 1,3 px na escala 1, 1,9 px na 1,5, 2,5 px na 2,25). O
  modelo final sai de um **reajuste iterado** (LO-RANSAC): inliers colhidos com 2× o limiar em
  torno do melhor modelo mínimo, DLT ponderado por `1/escala²` nesses inliers, novo inlier set com
  a margem encolhendo até 1× e repetição até o conjunto parar de mudar. Contra a homografia
  verdadeira, isso levou o erro médio de 0,32 para 0,24 px. Limiares abaixo de ~2,5 px pioram o
  resultado com lente distorcida: antes de κ₁ ser estimado a homografia não explica a borda da
  foto, o RANSAC fica só com o centro e a focal inicial sai errada (κ₁ = −0,2 com 2 px: 6° de erro).
- **Focal e rotação** (Aula 08 §8.2.3) — com `K = diag(f,f,1)` centrada, a ortonormalidade das duas
  primeiras colunas de `R = K⁻¹HK` dá `f² = −(h₀₀h₀₁+h₁₀h₁₁)/(h₂₀h₂₁)` e
  `f² = (h₀₁²+h₁₁²−h₀₀²−h₁₀²)/(h₂₀²−h₂₁²)`; tomamos a mediana das estimativas de todos os pares. A
  matriz `K⁻¹HK` é projetada na rotação mais próxima por `R(RᵀR)^(−1/2)`.
- **Alinhamento global** (Aula 08 §8.3, Brown & Lowe 2007 §4) — Levenberg-Marquardt sobre o erro de
  reprojeção **nos dois sentidos** de cada correspondência, com erro robusto de **Huber (σ = 2 px)**
  e a covariância a priori do artigo (`σ_θ = π/16`, `σ_f = f̄/10`) como amortecimento. As derivadas
  em relação às rotações são **analíticas** (regra da cadeia pela projeção e pela distorção); as de
  `f` e κ₁ são diferenças centrais. Conferido contra diferenças finitas (erro relativo 1e-4). O
  Jacobiano é esparso (cada resíduo toca só as duas câmeras do par, a focal e κ₁: 8 colunas), então
  `JᵀWJ` é acumulada só nessas entradas e o sistema amortecido é resolvido por **Cholesky** (com
  eliminação gaussiana de reserva): 40 câmeras e 7 mil correspondências convergem em ~260 ms.
  Depois que o bundle refinou a focal, fotos novas não a misturam mais com a mediana das
  homografias.
- **Distorção radial** (Aula 01 §2.1.5, Aula 08 §8.2.1) — um termo, `d = n·(1 + κ₁|n|²)` em
  coordenadas normalizadas pela focal. κ₁ é um parâmetro compartilhado do bundle (a partir de 3
  câmeras, a priori σ = 0,1): as observações ficam em pixels crus, o ponto de origem é
  desdistorcido (Newton sobre o raio) e a projeção no destino é distorcida. O warp aplica a mesma
  distorção ao buscar cada pixel na foto. Com κ₁ estimado, o RANSAC, a focal a partir de H e a
  rotação inicial passam a usar os pontos **desdistorcidos** — a homografia entre pontos
  desdistorcidos é exata para câmera que gira —, enquanto o desenho na tela e as observações do
  bundle continuam em pixels crus. Como as primeiras ligações foram ajustadas ainda com κ₁ = 0,
  o refino ocioso (e a exportação) **refaz as ligações** quando κ₁ se afasta mais de 0,01 do valor
  usado nelas e roda o bundle de novo (κ₁ = −0,2: erro de yaw de 1,27° para 0,3°). O centro óptico
  é `(W − 1)/2` em coordenadas de índice de pixel, a mesma convenção nas resoluções de análise e
  de composição e no shader.
- **Composição** (Aula 08 §8.4, Aula 02 §3.5.5, Aula 04 §3.5) — cada pixel da tela gera um raio, o
  raio vai para a câmera por `R`, é distorcido por κ₁ e amostrado na fonte (warp inverso, sem
  buracos). Quando a tela reduz a foto, a amostragem usa **mipmaps** com nível escolhido pela
  derivada local do mapeamento (o pré-filtro antes de decimar da Aula 04); quando amplia, bilinear.
  Multibanda por **pirâmide laplaciana** de Burt & Adelson: cada foto vira pirâmide gaussiana
  (binomial 5×5, decimação por 2) e cada banda é acumulada **na própria resolução** da pirâmide
  (tiles alinhados a múltiplos de 64 px para as grades coincidirem); a imagem é reconstruída
  expandindo do nível mais grosso ao mais fino só na região coberta.
- **Exposição e vinheta** (Aula 08 §8.4, Brown & Lowe §6) — ganhos por imagem minimizando
  `½ ΣΣ N_ij((g_i Ī_ij − g_j Ī_ji)²/σ_N² + (1 − g_i)²/σ_g²)` com os valores do artigo
  (`σ_N = 10`, `σ_g = 0,1`) e `N_ij` a área de sobreposição. A soma é sobre pares **ordenados**, então
  ao derivar em `g_i` o termo de dados entra duas vezes e o de prior uma:
  `g_i = Σ N(2·g_j Ī_ji Ī_ij/σ_N² + 1/σ_g²) / Σ N(2·Ī_ij²/σ_N² + 1/σ_g²)` (um teste confere que o
  resultado é ponto estacionário desse objetivo). Antes disso, a vinheta
  `V(r) = 1 + β r²` (Aula 01, queda cos⁴) é estimada por Gauss-Newton em log-intensidade a partir de
  amostras nos inliers de cada par, junto com um log-ganho por câmera, com Huber e modelo de ruído
  `σ = 0,08`; o warp divide cada pixel por `V(r)` e as médias de sobreposição são corrigidas antes
  dos ganhos.
- **Endireitamento** — vetor "para cima" como autovetor de menor autovalor da covariância dos eixos
  X das câmeras, aplicado como rotação global da tela.

## Verificação

Três camadas: `npm test` roda os **testes unitários** de cada etapa (modelos recuperados
exatamente, inversas, casos degenerados, o objetivo de ganho do artigo, a emenda de 360°);
`npm run verify` roda o pipeline inteiro contra ground truth; `npm run e2e` roda a app no Chrome.

`npm run verify` monta um mundo equirretangular procedural (hash multiescala, detalhe em qualquer
zoom), renderiza vistas com rotação conhecida e confere o pipeline contra o ground truth:

- focal a partir de H com erro < 2 % e `H → R` com desvio < 0,2°;
- detecção multiescala casando uma vista com a mesma vista ampliada 1,6× (76 inliers contra 4 da
  escala única, escala recuperada 1,601);
- 6 fotos em varredura horizontal, grade de 2 fileiras, lente com barril (κ₁ = −0,10 e −0,20),
  lente com vinheta (β = −0,25), cilíndrica+feather e planar+afim: **todas** integradas, focal
  recuperada com 0,1–2 % de erro, yaw dentro de 1,5°;
- κ₁ recuperado (−0,102 para −0,10 e −0,197 para −0,20) e β recuperado (−0,24 para −0,25), e
  nenhuma vinheta inventada nas cenas sem vinheta (|β| < 0,1);
- refino global preservando o alinhamento;
- exportação amostrada acima da prévia e dentro do teto de megapixels, e exportação em ladrilhos de
  256 px idêntica à de um ladrilho único (PNG decodificado e comparado pixel a pixel);
- bundle adjustment reduzindo o erro de reprojeção de 7–41 px para ~0,9 px;
- imagem intrusa de outra cena rejeitada (4–5 inliers contra ~70 dos pares válidos);
- objeto móvel detectado como pixels inconsistentes na sobreposição;
- custo por foto estável com N crescente e no máximo 5 pares avaliados por foto.

`npm run e2e` (29 checagens) sobe o Chrome headless com uma câmera falsa (`--use-file-for-fake-video-capture`
alimentado por um Y4M sintético), clica no disparador 7 vezes e confere no navegador real:
getUserMedia, acumulação no canvas, HUD com a contagem de fotos, linhas desenhadas sobre a câmera
(~50 k px pintados), rastreamento ao vivo (6/6 amostras) acompanhando cada quadro da câmera falsa
(10 atualizações/s a 10 fps), linhas atrás dos controles e só sobre o vídeo (ordem de
empilhamento conferida), popup de comparação aberto pelo botão (74 inliers, 88 % dos pares,
0,7 px) com o **✕** inteiro dentro do quadro, **✕** e **⬇** do minimapa ampliado sem
sobreposição, os cinco aceleradores de fato em WebGL2 (o rótulo precisa começar por `webgl2`),
exportação bloqueada enquanto o selo diz `compositing` e liberada depois, exportação real de um PNG
em resolução cheia, selects refletindo os parâmetros ativos, recomposição ao trocar a superfície,
grafo renderizado, diálogo de reinício que cancela sem apagar, ícones centrados (desvio 0,00 px) e
ausência de erros de console. Capturas de
tela ficam em `/tmp/e2e`.

## Mapeamento com o enunciado

| item | onde |
|---|---|
| Etapa 1 — coleta com sobreposição e objeto móvel | captura na própria app; `npm run fakecam` gera uma cena com objeto móvel para teste |
| Etapa 2 — dois detectores comparados, escala e orientação | `detector` no painel (Harris / Shi-Tomasi / FAST); card ampliado desenha escala e orientação |
| Etapa 3 — FLANN/BF, ratio test, antes e depois | força bruta em Hamming + ratio test; vetores ao vivo sobre a câmera e card com reprovadas tracejadas |
| Etapa 4 — ordenação automática sem EXIF, matriz/grafo, intrusa rejeitada | `vision/registration/alignment/pose-graph.ts`, overlay ⓘ, botão *reordenar* (`resolveFromScratch`) |
| Etapa 5 — homografia por RANSAC, taxa de inliers, erro de reprojeção | `vision/registration/estimation/ransac-estimator.ts`; popup de comparação e overlay ⓘ reportam inliers, taxa e erro |
| Etapa 6 — composição, blending, deghosting | `vision/compositing/seams/`, `vision/compositing/blending/`: feather, multibanda, costura geodésica, pixels inconsistentes |
| X1 — ajuste global em vez de encadeamento | bundle adjustment em janela durante a captura e global no tempo ocioso (`vision/registration/alignment/bundle-adjuster.ts`) |
| X2 — 360° com projeção cilíndrica/esférica | `surface` no painel (padrão plano); cilindro cobre 360° e a esfera 360°×180° |
| X3 — compensação de exposição | ganhos por imagem estimados nas sobreposições, com a vinheta removida antes |
| X4 — comparação com referência pronta | **não feito**: não há `cv2.Stitcher` no navegador; a comparação precisa ser externa |

## Limites conhecidos

- **Paralaxe**: o modelo rotacional pressupõe giro no centro óptico. Cenas próximas com giro fora do
  ponto nodal deixam desalinhamento que nenhum bundle resolve — a costura esconde, não corrige.
- **Distorção radial com um termo só**: κ₁ cobre o barril/almofada típicos de celular; lentes
  muito grande-angulares (olho de peixe) pediriam κ₂ ou um modelo equidistante.
- **Primeiras fotos sem κ₁**: κ₁ só é estimado a partir de 3 câmeras; os dois primeiros pares são
  ajustados com pontos crus e só o refino global os corrige depois.
- **Escala só para casar**: a detecção é multiescala, mas o modelo de câmera tem uma focal única;
  fotos com zoom diferente casam, mas não entram no mesmo panorama com a geometria certa.
- **Sem importação de arquivos**: a app só trabalha com a câmera ao vivo; para testar sem câmera,
  use a câmera falsa do Chrome (`npm run fakecam` + `npm run e2e`).
- **Recompressão JPEG** (qualidade 0,94) das fontes arquivadas introduz uma perda pequena na
  mistura de fotos antigas quando um parâmetro é alterado depois e na exportação.
- **Ida e volta do ladrilho**: o warp roda na GPU mas o ladrilho volta à CPU para a costura (que
  precisa da cor) e sobe de novo para o mosaico. Ler só a grade reduzida da costura e aplicar a
  máscara na GPU tiraria essa viagem.
- **Seleção de GPU em celulares**: o mosaico na GPU exige `EXT_float_blend`; sem ele (vários
  celulares), a prévia e a exportação ficam na CPU — funcionam, mais devagar.
