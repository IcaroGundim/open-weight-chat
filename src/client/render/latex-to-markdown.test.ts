import { describe, expect, it } from 'vitest';
import { latexToMarkdown } from './latex-to-markdown';

/**
 * Os casos de `equation`, `align`, `tabular` e `\footnote` estão aqui de
 * propósito: são exatamente os quatro em que o `latex.js` falhou, e foram o
 * motivo de escrever este conversor. Se algum voltar a quebrar, o motivo da
 * decisão volta com ele.
 */

describe('conversão de LaTeX para Markdown', () => {
  it('separa preâmbulo, título e autor do corpo', () => {
    const doc = latexToMarkdown(String.raw`
\documentclass{article}
\title{Síntese da Economia do Crime}
\author{Icaro}
\begin{document}
Texto do corpo.
\end{document}`);
    expect(doc.title).toBe('Síntese da Economia do Crime');
    expect(doc.author).toBe('Icaro');
    expect(doc.markdown).toBe('Texto do corpo.');
    // O preâmbulo não pode vazar para a prévia.
    expect(doc.markdown).not.toContain('documentclass');
  });

  it('trata fragmento sem \\begin{document} como corpo inteiro', () => {
    // O modelo devolve seções soltas com frequência; recusar seria inútil.
    const doc = latexToMarkdown(String.raw`\section{Modelo}Texto.`);
    expect(doc.markdown).toContain('## Modelo');
    expect(doc.markdown).toContain('Texto.');
  });

  it('converte equation em matemática de bloco', () => {
    const doc = latexToMarkdown(String.raw`\begin{equation} E = mc^2 \end{equation}`);
    expect(doc.markdown).toContain('$$');
    expect(doc.markdown).toContain('E = mc^2');
  });

  it('converte align para aligned, que o KaTeX aceita', () => {
    // `align` de topo não é aceito por toda versão do KaTeX; `aligned` é, e a
    // semântica de & e \\ é a mesma.
    const doc = latexToMarkdown(String.raw`\begin{align} a &= b \\ c &= d \end{align}`);
    expect(doc.markdown).toContain('\\begin{aligned}');
    expect(doc.markdown).toContain('a &= b');
    expect(doc.markdown).not.toContain('\\begin{align}');
  });

  it('descarta o número de colunas do alignat, que o KaTeX não usa', () => {
    const doc = latexToMarkdown(String.raw`\begin{alignat}{2} a &= b \end{alignat}`);
    expect(doc.markdown).not.toContain('{2}');
    expect(doc.markdown).toContain('\\begin{aligned}');
  });

  it('não reescreve nada dentro da matemática', () => {
    // Sem proteção, \textbf viraria ** e o KaTeX receberia Markdown.
    const doc = latexToMarkdown(String.raw`Antes $\textbf{x} \_ y$ depois.`);
    expect(doc.markdown).toContain(String.raw`$\textbf{x} \_ y$`);
    expect(doc.markdown).not.toContain('**x**');
  });

  it('converte tabular em tabela GFM com a primeira linha de cabeçalho', () => {
    const doc = latexToMarkdown(String.raw`
\begin{tabular}{ll}
\hline
Variável & Efeito \\
$p$ & Negativo \\
\end{tabular}`);
    expect(doc.markdown).toContain('| Variável | Efeito |');
    expect(doc.markdown).toContain('| --- | --- |');
    expect(doc.markdown).toContain('Negativo');
    // As linhas de régua não podem sobrar como texto.
    expect(doc.markdown).not.toContain('hline');
  });

  it('converte listas, inclusive aninhadas', () => {
    const doc = latexToMarkdown(String.raw`
\begin{itemize}
  \item Probabilidade
  \item Multa
  \begin{enumerate}
    \item Fixa
    \item Variável
  \end{enumerate}
\end{itemize}`);
    expect(doc.markdown).toContain('- Probabilidade');
    expect(doc.markdown).toContain('1. Fixa');
  });

  it('converte notas de rodapé sem perder o texto', () => {
    const doc = latexToMarkdown(String.raw`Dissuasão\footnote{Becker, 1968.} importa.`);
    expect(doc.markdown).toContain('Becker, 1968.');
    expect(doc.markdown).not.toContain('\\footnote');
  });

  it('converte ênfase, links e código', () => {
    const doc = latexToMarkdown(String.raw`\textbf{forte}, \emph{ênfase}, \texttt{cod}, \href{https://x.com}{link}`);
    expect(doc.markdown).toContain('**forte**');
    expect(doc.markdown).toContain('*ênfase*');
    expect(doc.markdown).toContain('`cod`');
    expect(doc.markdown).toContain('[link](https://x.com)');
  });

  it('respeita aninhamento de chaves na ênfase', () => {
    // Busca ingênua pelo primeiro `}` cortaria no lugar errado.
    const doc = latexToMarkdown(String.raw`\textbf{a \emph{b} c}`);
    expect(doc.markdown).toBe('**a *b* c**');
  });

  it('não converte comando cujo nome é prefixo de outro', () => {
    const doc = latexToMarkdown(String.raw`\textbfx{a}`);
    expect(doc.markdown).not.toContain('**');
  });

  it('preserva o conteúdo de verbatim sem interpretá-lo', () => {
    const doc = latexToMarkdown(String.raw`
\begin{verbatim}
\section{isto não é um título}
\end{verbatim}`);
    expect(doc.markdown).toContain('```');
    expect(doc.markdown).toContain(String.raw`\section{isto não é um título}`);
    expect(doc.markdown).not.toContain('## isto');
  });

  it('remove comentários, mas não o escape de porcentagem', () => {
    const doc = latexToMarkdown(String.raw`Taxa de 10\% ao ano. % comentário some
Fim.`);
    expect(doc.markdown).toContain('10% ao ano');
    expect(doc.markdown).not.toContain('comentário');
    expect(doc.markdown).toContain('Fim.');
  });

  it('traduz travessões e aspas do LaTeX', () => {
    // Aspas do LaTeX são duas crases e dois apóstrofos; string comum aqui
    // porque crase dentro de template literal fecharia a string.
    const doc = latexToMarkdown('Um---dois, ``aspas\'\'.');
    expect(doc.markdown).toContain('—');
    expect(doc.markdown).toContain('“aspas”');
  });

  it('relata o que não soube converter em vez de fingir que rendeu', () => {
    const doc = latexToMarkdown(String.raw`\begin{document}\tikzpicture \foobar{x}\end{document}`);
    expect(doc.unsupported).toContain('\\tikzpicture');
    expect(doc.unsupported).toContain('\\foobar');
  });

  it('não deixa comando desconhecido sujar o texto', () => {
    const doc = latexToMarkdown(String.raw`Antes \foobar{x} depois.`);
    expect(doc.markdown).not.toContain('foobar');
    expect(doc.markdown).toContain('Antes');
    expect(doc.markdown).toContain('depois.');
  });

  it('sobrevive a fonte truncada no meio de um comando', () => {
    // Acontece o tempo todo durante o streaming do artefato.
    expect(() => latexToMarkdown(String.raw`\textbf{sem fechar`)).not.toThrow();
    expect(() => latexToMarkdown(String.raw`$x = `)).not.toThrow();
    expect(() => latexToMarkdown(String.raw`\begin{equation} E =`)).not.toThrow();
  });

  it('restaura marcadores de dois dígitos sem embaralhar', () => {
    // O marcador 1 é prefixo do 10: restaurar na ordem direta deixaria um "0"
    // solto no texto.
    const formulas = Array.from({ length: 12 }, (_, i) => `$x_{${i}}$`).join(' e ');
    const doc = latexToMarkdown(formulas);
    expect(doc.markdown).toContain('$x_{11}$');
    expect(doc.markdown).not.toMatch(/LTX\d/u);
  });

  it('não deixa \\label entrar na fórmula', () => {
    // O comando mora DENTRO do ambiente. Sem tirá-lo antes de proteger o
    // corpo, o KaTeX o imprime em vermelho no meio da equação.
    const doc = latexToMarkdown(String.raw`
\begin{equation}\label{eq:neuronio}
  y = f\left(\sum_{i=1}^{n} w_i x_i + b\right)
\end{equation}`);
    expect(doc.markdown).not.toContain('\\label');
    expect(doc.markdown).not.toContain('eq:neuronio');
    expect(doc.markdown).toContain('\\sum');
  });

  it('remove \\nonumber sem estragar o alinhamento', () => {
    const doc = latexToMarkdown(String.raw`\begin{align} a &= b \nonumber \\ c &= d \end{align}`);
    expect(doc.markdown).not.toContain('nonumber');
    expect(doc.markdown).toContain('a &= b');
  });

  it('converte o que está dentro de \\title e \\author', () => {
    // `\title{\textbf{...}}` é comum, e aparecia literalmente na prévia.
    const doc = latexToMarkdown(String.raw`
\title{\textbf{Redes Neurais Artificiais}}
\author{Icaro \emph{Lebregundim}}
\begin{document}
Corpo.
\end{document}`);
    expect(doc.title).toBe('**Redes Neurais Artificiais**');
    expect(doc.author).toBe('Icaro *Lebregundim*');
    expect(doc.title).not.toContain('textbf');
  });

  it('não transforma parágrafo indentado em bloco de código', () => {
    // Recuo não significa nada em LaTeX e significa "código" em Markdown.
    // Era o que escondia a matemática de um parágrafo depois de uma fórmula.
    const doc = latexToMarkdown(
      '\\begin{document}\n\\[ \\sigma(z) = 1 \\]\n    que mapeia para o intervalo $(0,1)$.\n\\end{document}',
    );
    expect(doc.markdown).not.toMatch(/^ {4}/mu);
    expect(doc.markdown).toContain('que mapeia para o intervalo');
    // E a fórmula do parágrafo continua sendo fórmula.
    expect(doc.markdown).toContain('$(0,1)$');
  });

  it('mantém o recuo que ele mesmo gera para listas aninhadas', () => {
    // A remoção de recuo não pode comer a indentação da lista interna.
    const doc = latexToMarkdown(String.raw`
\begin{itemize}
  \item Externo
  \begin{itemize}
    \item Interno
  \end{itemize}
\end{itemize}`);
    expect(doc.markdown).toMatch(/\n {2}- Interno/u);
  });

  it('converte um documento acadêmico inteiro sem lançar', () => {
    const doc = latexToMarkdown(String.raw`
\documentclass[12pt]{article}
\usepackage{amsmath}
\usepackage[utf8]{inputenc}
\title{Síntese da Economia do Crime}
\author{Icaro}
\date{\today}
\begin{document}
\maketitle
\begin{abstract}
O modelo de Becker trata o crime como escolha sob incerteza.
\end{abstract}
\section{Modelo}\label{sec:modelo}
O agente age quando $pU(W-f) > U(W_0)$, conforme \cite{becker1968}.
\begin{equation}
  E[U] = p\,U(W-f) + (1-p)\,U(W)
\end{equation}
\subsection{Parâmetros}
\begin{itemize}
  \item $p$: probabilidade de punição\footnote{Estimada empiricamente.}
  \item $f$: multa
\end{itemize}
\begin{thebibliography}{9}
\bibitem{becker1968} Becker, G. \emph{Crime and Punishment}. 1968.
\end{thebibliography}
\end{document}`);
    expect(doc.title).toBe('Síntese da Economia do Crime');
    expect(doc.markdown).toContain('## Modelo');
    expect(doc.markdown).toContain('### Parâmetros');
    expect(doc.markdown).toContain('> O modelo de Becker');
    expect(doc.markdown).toContain('$$');
    expect(doc.markdown).toContain('[becker1968]');
    expect(doc.markdown).toContain('## Referências');
    expect(doc.markdown).toContain('Estimada empiricamente.');
    expect(doc.markdown).not.toContain('\\usepackage');
    expect(doc.markdown).not.toMatch(/LTX\d/u);
  });
});

describe('figuras em TikZ', () => {
  it('marca a figura pela legenda em vez de deixá-la sumir', () => {
    // TikZ é código de desenho: sem compilador TeX não há como renderizá-lo.
    // O que não pode acontecer é a figura desaparecer da prévia sem rastro.
    const doc = latexToMarkdown(String.raw`
\begin{figure}[h]
\centering
\begin{tikzpicture}
  \draw (0,0) -- (2,2);
\end{tikzpicture}
\caption{Reta de regressão}
\end{figure}`);
    expect(doc.markdown).toContain('Figura (TikZ)');
    expect(doc.markdown).toContain('Reta de regressão');
    // E o código do desenho não vaza como texto.
    expect(doc.markdown).not.toContain('\\draw');
  });

  it('marca tikzpicture solto, sem figure em volta', () => {
    const doc = latexToMarkdown(String.raw`\begin{tikzpicture}\draw (0,0) circle (1);\end{tikzpicture}`);
    expect(doc.markdown).toContain('Figura (TikZ)');
  });

  it('não mexe em figure sem tikz', () => {
    const doc = latexToMarkdown(String.raw`\begin{figure}\caption{Só legenda}\end{figure}`);
    expect(doc.markdown).not.toContain('TikZ');
    expect(doc.markdown).toContain('Só legenda');
  });
});

describe('acentos no estilo antigo do LaTeX', () => {
  it('traduz as formas com e sem chave', () => {
    // O modelo escreve assim, e sem traduzir a limpeza de comandos comia o
    // acento junto com a letra: "identifica\c{c}\~ao" virava "identifica ao".
    const doc = latexToMarkdown(String.raw`identifica\c{c}\~ao e m\'etodo can\^onico`);
    expect(doc.markdown).toBe('identificação e método canônico');
  });

  it('cobre os acentos do português', () => {
    const doc = latexToMarkdown(String.raw`\'a \`a \^e \~o \c{c} \"u`);
    expect(doc.markdown).toContain('á');
    expect(doc.markdown).toContain('à');
    expect(doc.markdown).toContain('ê');
    expect(doc.markdown).toContain('õ');
    expect(doc.markdown).toContain('ç');
    expect(doc.markdown).toContain('ü');
  });

  it('não estraga matemática que usa til e circunflexo', () => {
    // `\hat` e `\tilde` são comandos matemáticos e ficam protegidos.
    const doc = latexToMarkdown(String.raw`Valor $\hat{y}_i$ e $\tilde{x}$.`);
    expect(doc.markdown).toContain('\\hat{y}');
    expect(doc.markdown).toContain('\\tilde{x}');
  });

  it('comando desconhecido leva o argumento junto, sem deixar chaves órfãs', () => {
    // `\title{...}` virava `{...}` na tela, com as chaves à mostra.
    const doc = latexToMarkdown(String.raw`\begin{document}\foobar{Texto do argumento}Depois.\end{document}`);
    expect(doc.markdown).not.toContain('{');
    expect(doc.markdown).not.toContain('Texto do argumento');
    expect(doc.markdown).toContain('Depois.');
  });

  it('argumento com chave aninhada também é consumido', () => {
    const doc = latexToMarkdown(String.raw`\foobar{a {b} c}Fim.`);
    expect(doc.markdown).toBe('Fim.');
  });
});
