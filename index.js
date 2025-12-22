require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();

/* ======================
   MIDDLEWARES
====================== */
app.use(cors());
app.use(express.json());

/* ======================
   ROTA DE TESTE (OBRIGATÓRIA)
====================== */
app.get('/', (req, res) => {
  res.send('🚀 API Banked online');
});

/* ======================
   CONEXÃO COM NEON
====================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ======================
   1. CADASTRO
====================== */
app.post('/usuarios', async (req, res) => {
  try {
    const { nome, email, senha, celular, cpf } = req.body;

    if (!nome || !email || !senha) {
      return res.status(400).json({ erro: 'Dados obrigatórios ausentes.' });
    }

    const regexSenha =
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*[$*&@#])[0-9a-zA-Z$*&@#]{8,}$/;

    if (!regexSenha.test(senha)) {
      return res.status(400).json({
        erro: 'Senha fraca: mínimo 8 caracteres, maiúscula, minúscula e símbolo.'
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
      VALUES ($1,$2,$3,$4,$5,0,0,5,0,1)
      RETURNING id, nome, email, saldo, diamantes, vidas, nivel
    `;

    const { rows } = await pool.query(query, [
      nome,
      email,
      senhaHash,
      celular,
      cpf
    ]);

    res.status(201).json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao criar conta.' });
  }
});

/* ======================
   2. LOGIN
====================== */
app.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;

    const { rows } = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1',
      [email]
    );

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
    console.error(err);
    res.status(500).json({ erro: 'Erro no login.' });
  }
});

/* ======================
   3. SALDO
====================== */
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

/* ======================
   4. PONTUAÇÃO
====================== */
app.post('/pontuacao', async (req, res) => {
  const { usuario_id, jogo, pontos } = req.body;
  const pontosNum = parseInt(pontos) || 0;
  const diamantesGanhos = Math.floor(pontosNum / 100);

  try {
    await pool.query('BEGIN');

    await pool.query(
      'INSERT INTO historico_jogos (usuario_id, jogo, pontos) VALUES ($1,$2,$3)',
      [usuario_id, jogo, pontosNum]
    );

    await pool.query(
      'UPDATE usuarios SET diamantes = diamantes + $1, xp = xp + $2 WHERE id = $3',
      [diamantesGanhos, pontosNum, usuario_id]
    );

    await pool.query('COMMIT');
    res.json({ mensagem: 'Pontuação registrada!' });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ erro: 'Erro ao salvar pontuação.' });
  }
});

/* ======================
   5. PERGUNTAS
====================== */
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
        erro: 'Você já respondeu todas as perguntas desta categoria.'
      });
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao carregar perguntas.' });
  }
});

/* ======================
   6. REGISTRAR RESPOSTA
====================== */
app.post('/registrar-resposta', async (req, res) => {
  const { usuario_id, pergunta_id, acertou } = req.body;

  try {
    await pool.query(
      'INSERT INTO respostas_usuarios (usuario_id, pergunta_id, acertou) VALUES ($1,$2,$3)',
      [usuario_id, pergunta_id, acertou]
    );

    res.json({ mensagem: 'Resposta salva!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar resposta.' });
  }
});

/* ======================
   7. REPETIR QUESTÃO
====================== */
app.post('/quiz/repetir', async (req, res) => {
  const { usuario_id } = req.body;

  try {
    const { rows } = await pool.query(
      'SELECT diamantes FROM usuarios WHERE id = $1',
      [usuario_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }

    if (rows[0].diamantes < 10) {
      return res.status(400).json({ erro: 'Diamantes insuficientes.' });
    }

    await pool.query(
      'UPDATE usuarios SET diamantes = diamantes - 10 WHERE id = $1',
      [usuario_id]
    );

    res.json({ mensagem: '10 diamantes descontados.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao descontar diamantes.' });
  }
});

/* ======================
   8. RANKING
====================== */
app.get('/ranking', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT nome, xp, nivel, diamantes FROM usuarios ORDER BY xp DESC LIMIT 50'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar ranking.' });
  }
});

/* ======================
   9. SAQUE
====================== */
app.post('/sacar', async (req, res) => {
  const { usuario_id, valor, chave_pix } = req.body;

  try {
    const { rows } = await pool.query(
      'SELECT saldo FROM usuarios WHERE id = $1',
      [usuario_id]
    );

    if (parseFloat(rows[0].saldo) < valor) {
      return res.status(400).json({ erro: 'Saldo insuficiente.' });
    }

    await pool.query('BEGIN');

    await pool.query(
      'UPDATE usuarios SET saldo = saldo - $1 WHERE id = $2',
      [valor, usuario_id]
    );

    await pool.query(
      'INSERT INTO saques (usuario_id, valor, chave_pix, status) VALUES ($1,$2,$3,$4)',
      [usuario_id, valor, chave_pix, 'em_analise']
    );

    await pool.query('COMMIT');
    res.json({ mensagem: 'Saque enviado para análise.' });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ erro: 'Erro no saque.' });
  }
});

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🔥 Servidor Banked rodando na porta ${PORT}`)
);
