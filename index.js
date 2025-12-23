require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();

/* ========================================================
   CONFIGURAÇÕES
======================================================== */
app.use(cors());
app.use(express.json());

/* ========================================================
   BANCO DE DADOS – NEON
======================================================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect(err => {
  if (err) console.error('❌ Erro banco:', err.message);
  else console.log('✅ Banco Neon conectado');
});

/* ========================================================
   PING
======================================================== */
app.get('/', (_, res) => {
  res.send('🚀 API Banked online');
});

/* ========================================================
   CADASTRO
======================================================== */
app.post('/usuarios', async (req, res) => {
  try {
    const { nome, email, senha, celular, cpf } = req.body;
    if (!nome || !email || !senha)
      return res.status(400).json({ erro: 'Dados obrigatórios ausentes.' });

    const check = await pool.query(
      'SELECT id FROM usuarios WHERE email=$1 OR cpf=$2 OR celular=$3',
      [email, cpf, celular]
    );
    if (check.rows.length)
      return res.status(409).json({ erro: 'Usuário já existe.' });

    const senhaHash = await bcrypt.hash(senha, 10);

    const { rows } = await pool.query(`
      INSERT INTO usuarios
      (nome,email,senha_hash,celular,cpf,saldo,diamantes,vidas,xp,nivel)
      VALUES ($1,$2,$3,$4,$5,0,20,5,0,1)
      RETURNING id,nome,email,saldo,diamantes,vidas,xp,nivel
    `, [nome, email, senhaHash, celular, cpf]);

    res.status(201).json({ user: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro no cadastro' });
  }
});

/* ========================================================
   LOGIN
======================================================== */
app.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const { rows } = await pool.query(
      'SELECT * FROM usuarios WHERE email=$1',
      [email]
    );
    if (!rows.length)
      return res.status(401).json({ erro: 'Usuário não encontrado' });

    const user = rows[0];
    const ok = await bcrypt.compare(senha, user.senha_hash);
    if (!ok)
      return res.status(401).json({ erro: 'Senha inválida' });

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
  } catch {
    res.status(500).json({ erro: 'Erro no login' });
  }
});

/* ========================================================
   SALDO
======================================================== */
app.get('/saldo/:id', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT saldo,diamantes,vidas,xp,nivel FROM usuarios WHERE id=$1',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ erro: 'Usuário não existe' });
  res.json(rows[0]);
});

/* ========================================================
   PERGUNTAS QUIZ
======================================================== */
app.get('/perguntas/:usuario_id/:categoria', async (req, res) => {
  const { usuario_id, categoria } = req.params;

  const { rows } = await pool.query(`
    SELECT id, pergunta AS q,
    json_build_array(opcao_a,opcao_b,opcao_c,opcao_d) AS options,
    resposta_correta AS answer
    FROM perguntas
    WHERE categoria=$1
    AND id NOT IN (
      SELECT pergunta_id FROM respostas_usuarios WHERE usuario_id=$2
    )
    ORDER BY RANDOM()
    LIMIT 10
  `, [categoria, usuario_id]);

  if (!rows.length)
    return res.status(404).json({ erro: 'Sem perguntas disponíveis' });

  res.json(rows);
});

/* ========================================================
   REGISTRAR RESPOSTA
======================================================== */
app.post('/registrar-resposta', async (req, res) => {
  const { usuario_id, pergunta_id, acertou } = req.body;
  await pool.query(
    'INSERT INTO respostas_usuarios (usuario_id,pergunta_id,acertou) VALUES ($1,$2,$3)',
    [usuario_id, pergunta_id, acertou]
  );
  res.json({ ok: true });
});

/* ========================================================
   TENTAR NOVAMENTE (NOVA PERGUNTA)
======================================================== */
app.get('/pergunta-extra/:usuario_id/:categoria', async (req, res) => {
  const { usuario_id, categoria } = req.params;

  const saldo = await pool.query(
    'SELECT diamantes FROM usuarios WHERE id=$1',
    [usuario_id]
  );

  if (!saldo.rows.length || saldo.rows[0].diamantes < 10)
    return res.status(400).json({ erro: 'Diamantes insuficientes' });

  await pool.query(
    'UPDATE usuarios SET diamantes=diamantes-10 WHERE id=$1',
    [usuario_id]
  );

  const { rows } = await pool.query(`
    SELECT id, pergunta AS q,
    json_build_array(opcao_a,opcao_b,opcao_c,opcao_d) AS options,
    resposta_correta AS answer
    FROM perguntas
    WHERE categoria=$1
    ORDER BY RANDOM()
    LIMIT 1
  `, [categoria]);

  res.json(rows[0]);
});

/* ========================================================
   PRÊMIO DISPUTA
======================================================== */
app.post('/entrar-disputa', async (_, res) => {
  await pool.query(`
    UPDATE disputa_premio
    SET total = total + 5,
        participantes = participantes + 1
    WHERE id = 1
  `);
  res.json({ ok: true });
});

app.get('/premio', async (_, res) => {
  const { rows } = await pool.query(
    'SELECT total, participantes FROM disputa_premio WHERE id=1'
  );
  res.json(rows[0]);
});

/* ========================================================
   RANKING
======================================================== */
app.get('/ranking', async (_, res) => {
  const { rows } = await pool.query(
    'SELECT nome,xp,nivel,diamantes FROM usuarios ORDER BY xp DESC LIMIT 50'
  );
  res.json(rows);
});

/* ========================================================
   SAQUE PIX
======================================================== */
app.post('/sacar', async (req, res) => {
  const { usuario_id, valor, chave_pix } = req.body;

  try {
    await pool.query('BEGIN');

    const r = await pool.query(
      'SELECT saldo FROM usuarios WHERE id=$1',
      [usuario_id]
    );
    if (!r.rows.length || r.rows[0].saldo < valor)
      throw new Error('Saldo insuficiente');

    await pool.query(
      'UPDATE usuarios SET saldo=saldo-$1 WHERE id=$2',
      [valor, usuario_id]
    );

    await pool.query(
      'INSERT INTO saques (usuario_id,valor,chave_pix,status) VALUES ($1,$2,$3,$4)',
      [usuario_id, valor, chave_pix, 'em_analise']
    );

    await pool.query('COMMIT');
    res.json({ mensagem: 'Saque solicitado' });
  } catch (e) {
    await pool.query('ROLLBACK');
    res.status(400).json({ erro: e.message });
  }
});

/* ========================================================
   START
======================================================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🔥 Banked API rodando na porta ${PORT}`)
);
