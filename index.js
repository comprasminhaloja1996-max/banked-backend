require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();

/* ========================================================
   1. CORREÇÃO DEFINITIVA DE CORS (A "BALA DE PRATA")
   Isso responde imediatamente "SIM" para qualquer pergunta
   do navegador antes de tentar fazer o POST.
======================================================== */
app.use(cors()); // Middleware padrão

// O SEU CÓDIGO DE RESGATE:
app.options('*', (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.sendStatus(200); // Responde OK na hora
});

app.use(express.json());

/* ========================================================
   CONEXÃO COM O BANCO DE DADOS (NEON)
======================================================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.connect((err) => {
    if (err) console.error('❌ Erro Banco:', err.message);
    else console.log('✅ Banco Conectado!');
});

/* ========================================================
   ROTA DE TESTE
======================================================== */
app.get('/', (req, res) => {
  res.send('🚀 API Banked - CORS BLINDADO ATIVO!');
});

/* ========================================================
   2. ROTAS PRINCIPAIS
======================================================== */

// CADASTRO
app.post('/usuarios', async (req, res) => {
  try {
    const { nome, email, senha, celular, cpf } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: 'Dados incompletos' });

    const checkUser = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (checkUser.rows.length > 0) return res.status(409).json({ erro: 'Email já cadastrado.' });

    const senhaHash = await bcrypt.hash(senha, 10);
    const query = `
      INSERT INTO usuarios (nome, email, senha_hash, celular, cpf, saldo, diamantes, vidas, xp, nivel)
      VALUES ($1, $2, $3, $4, $5, 0, 0, 5, 0, 1)
      RETURNING id, nome, email, saldo, vidas
    `;
    const { rows } = await pool.query(query, [nome, email, senhaHash, celular, cpf]);
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro no cadastro.' });
  }
});

// LOGIN
app.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(401).json({ erro: 'Usuário não existe.' });

    const user = rows[0];
    const valid = await bcrypt.compare(senha, user.senha_hash);
    if (!valid) return res.status(401).json({ erro: 'Senha errada.' });

    res.json({ user: { id: user.id, nome: user.nome, email: user.email, saldo: user.saldo, vidas: user.vidas, diamantes: user.diamantes } });
  } catch (err) {
    res.status(500).json({ erro: 'Erro no login.' });
  }
});

// SALDO (ESSENCIAL)
app.get('/saldo/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT saldo, diamantes, vidas FROM usuarios WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar saldo' });
  }
});

// INICIAR JOGO (O BOTÃO JOGAR)
app.post('/jogo/inicio', async (req, res) => {
  const { usuario_id } = req.body;
  try {
    const result = await pool.query(
      'UPDATE usuarios SET vidas = vidas - 1 WHERE id = $1 AND vidas > 0 RETURNING vidas',
      [usuario_id]
    );

    if (result.rows.length === 0) {
        const check = await pool.query('SELECT id FROM usuarios WHERE id = $1', [usuario_id]);
        if (check.rows.length === 0) return res.status(404).json({ erro: 'Usuário inválido.' });
        return res.status(403).json({ erro: 'Sem vidas!' });
    }
    res.json({ mensagem: 'Bom jogo!', vidas_restantes: result.rows[0].vidas });
  } catch (err) {
    res.status(500).json({ erro: 'Erro no servidor' });
  }
});

// PONTUAÇÃO
app.post('/pontuacao', async (req, res) => {
  const { usuario_id, jogo, pontos } = req.body;
  const p = parseInt(pontos) || 0;
  const d = Math.floor(p / 100); 

  try {
    await pool.query('BEGIN');
    await pool.query('INSERT INTO historico_jogos (usuario_id, jogo, pontos) VALUES ($1, $2, $3)', [usuario_id, jogo, p]);
    await pool.query('UPDATE usuarios SET diamantes = diamantes + $1, xp = xp + $2 WHERE id = $3', [d, p, usuario_id]);
    await pool.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ erro: 'Erro ao salvar' });
  }
});

// PERGUNTAS
app.get('/perguntas/:usuario_id/:categoria', async (req, res) => {
  const { usuario_id, categoria } = req.params;
  try {
    const query = `
      SELECT id, pergunta AS q, 
      json_build_array(opcao_a, opcao_b, opcao_c, opcao_d) AS options, 
      resposta_correta AS answer 
      FROM perguntas 
      WHERE categoria = $1 
      ORDER BY RANDOM() LIMIT 10`;
    const { rows } = await pool.query(query, [categoria]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro nas perguntas' });
  }
});

app.post('/registrar-resposta', (req, res) => res.json({ ok: true }));

app.post('/quiz/repetir', async (req, res) => {
  const { usuario_id } = req.body;
  try {
    const { rows } = await pool.query('UPDATE usuarios SET diamantes = diamantes - 10 WHERE id = $1 AND diamantes >= 10 RETURNING diamantes', [usuario_id]);
    if (rows.length === 0) return res.status(400).json({ erro: 'Sem diamantes' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 Servidor ON na porta ${PORT}`));