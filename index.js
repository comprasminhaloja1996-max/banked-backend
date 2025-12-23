require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();

/* ========================================================
   CONFIGURAÇÕES E MIDDLEWARES
======================================================== */
app.use(cors()); // Libera acesso para o App e Sites
app.use(express.json());

/* ========================================================
   CONEXÃO COM O BANCO DE DADOS (NEON)
======================================================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Obrigatório para conexões externas no Neon
  }
});

// Teste de conexão ao iniciar
pool.connect((err) => {
    if (err) {
        console.error('❌ Erro ao conectar no Banco:', err.message);
    } else {
        console.log('✅ Conectado ao Banco Neon com sucesso!');
    }
});

/* ========================================================
   ROTA DE TESTE (PING)
======================================================== */
app.get('/', (req, res) => {
  res.send('🚀 API Banked online e rodando!');
});

/* ========================================================
   1. CADASTRO DE USUÁRIO
======================================================== */
app.post('/usuarios', async (req, res) => {
  try {
    const { nome, email, senha, celular, cpf } = req.body;

    if (!nome || !email || !senha) {
      return res.status(400).json({ erro: 'Dados obrigatórios ausentes.' });
    }

    // Regex de Senha Forte
    const regexSenha = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[$*&@#])[0-9a-zA-Z$*&@#]{8,}$/;
    if (!regexSenha.test(senha)) {
      return res.status(400).json({
        erro: 'Senha fraca: use 8 letras, 1 maiúscula, 1 minúscula e 1 símbolo.'
      });
    }

    const checkUser = await pool.query(
      'SELECT id FROM usuarios WHERE email = $1 OR cpf = $2 OR celular = $3',
      [email, cpf, celular]
    );

    if (checkUser.rows.length > 0) {
      return res.status(409).json({ erro: 'Usuário já cadastrado.' });
    }

    const senhaHash = await bcrypt.hash(senha, 10);

    const query = `
      INSERT INTO usuarios 
      (nome, email, senha_hash, celular, cpf, saldo, diamantes, vidas, xp, nivel)
      VALUES ($1, $2, $3, $4, $5, 0, 0, 5, 0, 1)
      RETURNING id, nome, email, saldo, diamantes, vidas, nivel
    `;

    const { rows } = await pool.query(query, [nome, email, senhaHash, celular, cpf]);

    res.status(201).json({ user: rows[0] });

  } catch (err) {
    console.error('Erro no cadastro:', err);
    res.status(500).json({ erro: 'Erro interno ao criar conta.' });
  }
});

/* ========================================================
   2. LOGIN
======================================================== */
app.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;

    const { rows } = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);

    if (rows.length === 0) {
      return res.status(401).json({ erro: 'Usuário não encontrado.' });
    }

    const user = rows[0];
    const senhaValida = await bcrypt.compare(senha, user.senha_hash);

    if (!senhaValida) {
      return res.status(401).json({ erro: 'Senha incorreta.' });
    }

    res.json({
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        saldo: user.saldo,
        diamantes: user.diamantes,
        vidas: user.vidas,
        xp: user.xp,
        nivel: user.nivel
      }
    });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ erro: 'Erro interno no login.' });
  }
});

/* ========================================================
   3. CONSULTAR SALDO
======================================================== */
app.get('/saldo/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT saldo, diamantes, vidas, nivel, xp FROM usuarios WHERE id = $1',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar saldo.' });
  }
});

/* ========================================================
   4. INICIAR JOGO (NOVO! - Desconta Vida)
======================================================== */
app.post('/jogo/inicio', async (req, res) => {
  const { usuario_id, jogo } = req.body; // ex: { usuario_id: 1, jogo: "nave" }

  try {
    // Tenta descontar 1 vida APENAS SE vidas > 0
    const result = await pool.query(
      'UPDATE usuarios SET vidas = vidas - 1 WHERE id = $1 AND vidas > 0 RETURNING vidas',
      [usuario_id]
    );

    // Se não retornou nada, é porque não tinha vidas ou usuário não existe
    if (result.rows.length === 0) {
        // Verifica se usuário existe só pra dar a msg certa
        const check = await pool.query('SELECT id FROM usuarios WHERE id = $1', [usuario_id]);
        if (check.rows.length === 0) return res.status(404).json({ erro: 'Usuário não existe.' });
        
        return res.status(403).json({ erro: 'Sem vidas para jogar! Espere recarregar.' });
    }

    // Sucesso: Retorna quantas vidas sobraram
    res.json({ 
        mensagem: 'Jogo iniciado! Boa sorte.', 
        vidas_restantes: result.rows[0].vidas 
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao iniciar jogo.' });
  }
});

/* ========================================================
   5. SALVAR PONTUAÇÃO (FIM DO JOGO)
======================================================== */
app.post('/pontuacao', async (req, res) => {
  const { usuario_id, jogo, pontos } = req.body;
  const pontosNum = parseInt(pontos) || 0;
  
  // Exemplo: Ganha 1 diamante a cada 100 pontos
  const diamantesGanhos = Math.floor(pontosNum / 100);

  try {
    await pool.query('BEGIN');

    // 1. Registra no histórico
    await pool.query(
      'INSERT INTO historico_jogos (usuario_id, jogo, pontos) VALUES ($1, $2, $3)',
      [usuario_id, jogo, pontosNum]
    );

    // 2. Dá os prêmios (Diamantes e XP)
    await pool.query(
      'UPDATE usuarios SET diamantes = diamantes + $1, xp = xp + $2 WHERE id = $3',
      [diamantesGanhos, pontosNum, usuario_id]
    );

    await pool.query('COMMIT');
    res.json({ mensagem: 'Pontuação registrada com sucesso!' });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Erro ao salvar pontos:', err);
    res.status(500).json({ erro: 'Erro ao processar pontuação.' });
  }
});

/* ========================================================
   6. BUSCAR PERGUNTAS (QUIZ)
======================================================== */
app.get('/perguntas/:usuario_id/:categoria', async (req, res) => {
  const { usuario_id, categoria } = req.params;

  try {
    const query = `
      SELECT id, pergunta AS q,
      json_build_array(opcao_a, opcao_b, opcao_c, opcao_d) AS options,
      resposta_correta AS answer
      FROM perguntas
      WHERE categoria = $1
      AND id NOT IN (
        SELECT pergunta_id FROM respostas_usuarios WHERE usuario_id = $2
      )
      ORDER BY RANDOM()
      LIMIT 10
    `;

    const { rows } = await pool.query(query, [categoria, usuario_id]);

    if (rows.length === 0) {
      return res.status(404).json({
        erro: 'Você já zerou todas as perguntas desta categoria!'
      });
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao carregar perguntas.' });
  }
});

/* ========================================================
   7. REGISTRAR RESPOSTA DO QUIZ
======================================================== */
app.post('/registrar-resposta', async (req, res) => {
  const { usuario_id, pergunta_id, acertou } = req.body;

  try {
    await pool.query(
      'INSERT INTO respostas_usuarios (usuario_id, pergunta_id, acertou) VALUES ($1, $2, $3)',
      [usuario_id, pergunta_id, acertou]
    );
    res.json({ mensagem: 'Resposta salva!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar resposta.' });
  }
});

/* ========================================================
   8. GASTAR DIAMANTES PARA REPETIR
======================================================== */
app.post('/quiz/repetir', async (req, res) => {
  const { usuario_id } = req.body;

  try {
    const { rows } = await pool.query('SELECT diamantes FROM usuarios WHERE id = $1', [usuario_id]);

    if (rows.length === 0) return res.status(404).json({ erro: 'Usuário sumiu.' });

    if (rows[0].diamantes < 10) {
      return res.status(400).json({ erro: 'Saldo insuficiente (Precisa de 10 diamantes).' });
    }

    await pool.query('UPDATE usuarios SET diamantes = diamantes - 10 WHERE id = $1', [usuario_id]);

    res.json({ mensagem: 'Diamantes descontados. Pode repetir!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro na transação de diamantes.' });
  }
});

/* ========================================================
   9. RANKING GLOBAL
======================================================== */
app.get('/ranking', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT nome, xp, nivel, diamantes FROM usuarios ORDER BY xp DESC LIMIT 50'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao carregar ranking.' });
  }
});

/* ========================================================
   10. SOLICITAR SAQUE PIX
======================================================== */
app.post('/sacar', async (req, res) => {
  const { usuario_id, valor, chave_pix } = req.body;

  try {
    const { rows } = await pool.query('SELECT saldo FROM usuarios WHERE id = $1', [usuario_id]);

    if (rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    if (parseFloat(rows[0].saldo) < valor) {
      return res.status(400).json({ erro: 'Saldo insuficiente.' });
    }

    await pool.query('BEGIN');

    await pool.query('UPDATE usuarios SET saldo = saldo - $1 WHERE id = $2', [valor, usuario_id]);

    await pool.query(
      'INSERT INTO saques (usuario_id, valor, chave_pix, status) VALUES ($1, $2, $3, $4)',
      [usuario_id, valor, chave_pix, 'em_analise']
    );

    await pool.query('COMMIT');
    res.json({ mensagem: 'Saque solicitado com sucesso! Aguarde aprovação.' });

  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ erro: 'Erro ao processar saque.' });
  }
});

/* ========================================================
   INICIALIZAÇÃO DO SERVIDOR
======================================================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Servidor Banked rodando na porta ${PORT}`);
});