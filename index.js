require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();

// ========================================================
// 1. CONFIGURAÇÃO DE SEGURANÇA (CORS & JSON)
// ========================================================
app.use(cors()); 
app.use(express.json());

// Rota para o navegador "acordar" o servidor
app.get('/', (req, res) => {
  res.status(200).send('🚀 API COMPLETA - QUIZ E JOGOS ATIVOS!');
});

// Força o CORS para todas as rotas (Preflight)
app.options('*', (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.sendStatus(200);
});

// ========================================================
// 2. CONEXÃO COM O BANCO DE DADOS
// ========================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Necessário para Render/Neon
});

pool.connect((err) => {
    if (err) console.error('❌ Erro de Conexão com Banco:', err.message);
    else console.log('✅ Banco de Dados Conectado!');
});

// ========================================================
// 3. ROTAS DE USUÁRIO (Login, Cadastro, Saldo)
// ========================================================

// Buscar Saldo, Vidas e Diamantes
app.get('/saldo/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT saldo, diamantes, vidas, xp, nivel FROM usuarios WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar saldo' });
  }
});

// Login
app.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(401).json({ erro: 'Usuário não existe.' });

    const valid = await bcrypt.compare(senha, rows[0].senha_hash);
    if (!valid) return res.status(401).json({ erro: 'Senha incorreta.' });

    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro no login.' });
  }
});

// Cadastro
app.post('/usuarios', async (req, res) => {
  try {
    const { nome, email, senha } = req.body;
    // Verifica se já existe
    const check = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (check.rows.length > 0) return res.status(400).json({ erro: 'Email já cadastrado' });

    const hash = await bcrypt.hash(senha, 10);
    const query = `
      INSERT INTO usuarios (nome, email, senha_hash, celular, cpf, saldo, diamantes, vidas, xp, nivel)
      VALUES ($1, $2, $3, '', '', 0, 10, 5, 0, 1)
      RETURNING *
    `;
    const { rows } = await pool.query(query, [nome, email, hash]);
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro no cadastro.' });
  }
});

// ========================================================
// 4. ROTAS DO JOGO (Vidas e Início)
// ========================================================

app.post('/jogo/inicio', async (req, res) => {
  const { usuario_id } = req.body;
  try {
    // 1. Verifica vidas atuais
    const userCheck = await pool.query('SELECT vidas FROM usuarios WHERE id = $1', [usuario_id]);
    if (userCheck.rows.length === 0) return res.status(404).json({ erro: 'Usuário inválido' });
    
    if (userCheck.rows[0].vidas <= 0) {
        return res.status(403).json({ erro: 'Sem vidas suficientes!' });
    }

    // 2. Desconta uma vida
    const result = await pool.query(
      'UPDATE usuarios SET vidas = vidas - 1 WHERE id = $1 RETURNING vidas',
      [usuario_id]
    );
    res.json({ mensagem: 'Bom jogo!', vidas_restantes: result.rows[0].vidas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao iniciar jogo' });
  }
});

// ========================================================
// 5. ROTAS DO QUIZ (Perguntas e Pontuação)
// ========================================================

// Buscar Perguntas Aleatórias por Categoria
app.get('/perguntas/:usuario_id/:categoria', async (req, res) => {
  const { categoria } = req.params;
  try {
    // Busca 10 perguntas aleatórias da categoria escolhida
    const query = `
        SELECT id, pergunta AS q, 
        json_build_array(opcao_a, opcao_b, opcao_c, opcao_d) AS options, 
        resposta_correta AS answer 
        FROM perguntas 
        WHERE categoria = $1 
        ORDER BY RANDOM() 
        LIMIT 10
    `;
    const { rows } = await pool.query(query, [categoria]);
    
    // Fallback: Se não tiver perguntas no banco, retorna array vazio (evita crash)
    if (rows.length === 0) {
        console.log(`⚠️ Nenhuma pergunta encontrada para categoria: ${categoria}`);
        return res.json([]); 
    }
    
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar perguntas' });
  }
});

// Registrar Resposta (Opcional - só para log)
app.post('/registrar-resposta', (req, res) => {
    // Aqui você pode salvar estatísticas de acerto/erro se quiser no futuro
    res.json({ ok: true });
});

// Salvar Pontuação Final e Dar Recompensa
app.post('/pontuacao', async (req, res) => {
  const { usuario_id, jogo, pontos } = req.body;
  const p = parseInt(pontos) || 0;
  
  // Regra: A cada 100 pontos = 1 Diamante
  const diamantesGanhos = Math.floor(p / 100); 

  try {
    await pool.query('BEGIN'); // Inicia transação
    
    // 1. Salva no histórico
    await pool.query(
        'INSERT INTO historico_jogos (usuario_id, jogo, pontos, data_jogo) VALUES ($1, $2, $3, NOW())', 
        [usuario_id, jogo, p]
    );

    // 2. Atualiza XP e Diamantes do usuário
    await pool.query(
        'UPDATE usuarios SET diamantes = diamantes + $1, xp = xp + $2 WHERE id = $3', 
        [diamantesGanhos, p, usuario_id]
    );

    await pool.query('COMMIT'); // Salva tudo
    res.json({ ok: true, diamantes: diamantesGanhos });
  } catch (err) {
    await pool.query('ROLLBACK'); // Desfaz se der erro
    console.error(err);
    res.status(500).json({ erro: 'Erro ao salvar pontuação' });
  }
});

// Gastar Diamantes para Repetir/Pular
app.post('/quiz/repetir', async (req, res) => {
  const { usuario_id } = req.body;
  try {
    // Tenta descontar 10 diamantes
    const result = await pool.query(
        'UPDATE usuarios SET diamantes = diamantes - 10 WHERE id = $1 AND diamantes >= 10 RETURNING diamantes',
        [usuario_id]
    );

    if (result.rows.length === 0) {
        return res.status(400).json({ erro: 'Diamantes insuficientes' });
    }
    res.json({ ok: true, diamantes: result.rows[0].diamantes });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao processar' });
  }
});

// ========================================================
// 6. INICIALIZAÇÃO DO SERVIDOR
// ========================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Servidor ON na porta ${PORT}`);
});
