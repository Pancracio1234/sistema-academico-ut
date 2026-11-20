const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Conexión a la base de datos asistencia_db
const pool = process.env.DATABASE_URL
    ? new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false }
      })
    : new Pool({
          user: 'postgres',
          host: 'localhost',
          database: 'asistencia_db',
          password: 'Albaricoque98)',
          port: 5432,
      });

// Middleware: verifica que la petición venga de un docente autenticado
async function verificarDocente(req, res, next) {
    const docenteId = req.headers['x-docente-id'];
    if (!docenteId) {
        return res.status(401).json({ error: 'Acceso denegado. Debes iniciar sesión como Docente.' });
    }
    try {
        const result = await pool.query('SELECT prof_id, prof_nombre FROM public.profesor WHERE prof_id = $1', [docenteId]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Sesión de docente inválida o expirada.' });
        }
        req.docente = result.rows[0];
        next();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// Diccionario con las 9 consultas analíticas
const consultas = {
    q1: {
        titulo: "1. Nombres y apellidos en mayúsculas",
        sql: "SELECT UPPER(estu_nombre) AS nombre_mayusculas FROM public.estudiante;"
    },
    q2: {
        titulo: "2. Nombre completo y longitud de caracteres",
        sql: "SELECT estu_nombre AS nombre_completo, LENGTH(estu_nombre) AS longitud FROM public.estudiante;"
    },
    q3: {
        titulo: "3. Promedio general de notas",
        sql: "SELECT ROUND(AVG(estu_nota), 2) AS promedio_general FROM public.estudiante;"
    },
    q4: {
        titulo: "4. Nota máxima y mínima por estudiante",
        sql: "SELECT estu_nombre, MAX(estu_nota) AS nota_maxima, MIN(estu_nota) AS nota_minima FROM public.estudiante GROUP BY estu_nombre;"
    },
    q5: {
        titulo: "5. Clasificación de notas usando CASE",
        sql: "SELECT estu_nombre, estu_programa, estu_nota, CASE WHEN estu_nota >= 4.5 THEN 'Excelente' WHEN estu_nota >= 3.0 THEN 'Aprobado' ELSE 'Reprobado' END AS estado FROM public.estudiante;"
    },
    q6: {
        titulo: "6. Cantidad de estudiantes por programa académico",
        sql: "SELECT estu_programa, COUNT(estu_id) AS total_estudiantes FROM public.estudiante GROUP BY estu_programa;"
    },
    q7: {
        titulo: "7. Programas académicos con más de 20 estudiantes",
        sql: "SELECT estu_programa, COUNT(estu_id) AS total_estudiantes FROM public.estudiante GROUP BY estu_programa HAVING COUNT(estu_id) > 20;"
    },
    q8: {
        titulo: "8. Días transcurridos desde cada matrícula",
        sql: "SELECT estu_nombre, fecha_matricula, (CURRENT_DATE - fecha_matricula) AS dias_transcurridos FROM public.estudiante;"
    },
    q9: {
        titulo: "9. Reemplazar correos nulos por 'No registrado'",
        sql: "SELECT estu_id, estu_nombre, COALESCE(estu_correo, 'No registrado') AS correo FROM public.estudiante;"
    }
};

// ============================================================================
// RUTAS PÚBLICAS (CONSULTAS, CATÁLOGOS Y AUTENTICACIÓN)
// ============================================================================

app.get('/api/reportes/:id', async (req, res) => {
    const consulta = consultas[req.params.id];
    if (!consulta) return res.status(404).json({ error: 'Consulta no encontrada' });

    try {
        const resultado = await pool.query(consulta.sql);
        res.json({
            titulo: consulta.titulo,
            sql: consulta.sql,
            datos: resultado.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/catalogos', async (req, res) => {
    try {
        const materias = await pool.query(`
            SELECT m.mate_id, m.mate_nombre, m.mate_codigo, m.refi_id, m.prof_id,
                   p.prof_nombre, r.refi_descripcion
            FROM public.materia m
            JOIN public.profesor p ON m.prof_id = p.prof_id
            JOIN public.recursofisico r ON m.refi_id = r.refi_id
            ORDER BY m.mate_id ASC
        `);
        const profesores = await pool.query('SELECT prof_id, prof_documento, prof_nombre, prof_correo FROM public.profesor ORDER BY prof_id ASC');
        const recursos = await pool.query('SELECT refi_id, refi_descripcion, refi_capacidad FROM public.recursofisico ORDER BY refi_id ASC');
        const programas = await pool.query('SELECT prog_id, prog_nombre FROM public.programa ORDER BY prog_nombre ASC');
        const estudiantes = await pool.query(`
            SELECT e.estu_id, e.estu_documento, e.estu_nombre, e.estu_correo, e.estu_programa, e.estu_nota, e.fecha_matricula, m.mate_nombre
            FROM public.estudiante e
            LEFT JOIN public.materia m ON e.mate_id = m.mate_id
            ORDER BY e.estu_programa ASC, e.estu_nombre ASC
        `);

        res.json({
            materias: materias.rows,
            profesores: profesores.rows,
            recursos: recursos.rows,
            programas: programas.rows,
            estudiantes: estudiantes.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Registro de nuevo Docente
app.post('/api/profesores', async (req, res) => {
    const { prof_documento, prof_nombre, prof_correo, prof_password } = req.body;
    try {
        if (!prof_password || prof_password.trim().length < 4) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres.' });
        }
        const correoFinal = prof_correo && prof_correo.trim() !== '' ? prof_correo.trim() : null;
        const nuevo = await pool.query(
            'INSERT INTO public.profesor (prof_documento, prof_nombre, prof_correo, prof_password) VALUES ($1, $2, $3, $4) RETURNING prof_id, prof_documento, prof_nombre, prof_correo',
            [prof_documento, prof_nombre, correoFinal, prof_password.trim()]
        );
        res.json(nuevo.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Inicio de sesión de Docente
app.post('/api/login-docente', async (req, res) => {
    const { identificador, password } = req.body;
    try {
        const result = await pool.query(
            `SELECT prof_id, prof_documento, prof_nombre, prof_correo 
             FROM public.profesor 
             WHERE (LOWER(prof_correo) = LOWER($1) OR CAST(prof_documento AS TEXT) = $1) 
               AND prof_password = $2`,
            [identificador.trim(), password.trim()]
        );
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Credenciales de docente incorrectas.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// NUEVO: Inicio de sesión de Estudiante (por Documento o Correo + Contraseña)
app.post('/api/login-estudiante', async (req, res) => {
    const { identificador, password } = req.body;
    try {
        const result = await pool.query(
            `SELECT e.estu_id, e.estu_documento, e.estu_nombre, e.estu_correo, e.estu_programa, e.estu_nota, e.fecha_matricula,
                    m.mate_nombre, m.mate_codigo, p.prof_nombre, r.refi_descripcion
             FROM public.estudiante e
             LEFT JOIN public.materia m ON e.mate_id = m.mate_id
             LEFT JOIN public.profesor p ON m.prof_id = p.prof_id
             LEFT JOIN public.recursofisico r ON m.refi_id = r.refi_id
             WHERE (CAST(e.estu_documento AS TEXT) = $1 OR LOWER(e.estu_correo) = LOWER($1))
               AND e.estu_password = $2`,
            [identificador.trim(), password.trim()]
        );
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Documento/correo o contraseña de estudiante incorrectos.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// NUEVO: Consultar boletín actualizado de un estudiante autenticado
app.get('/api/estudiantes/:id/boletin', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT e.estu_id, e.estu_documento, e.estu_nombre, e.estu_correo, e.estu_programa, e.estu_nota, e.fecha_matricula,
                    m.mate_nombre, m.mate_codigo, p.prof_nombre, r.refi_descripcion
             FROM public.estudiante e
             LEFT JOIN public.materia m ON e.mate_id = m.mate_id
             LEFT JOIN public.profesor p ON m.prof_id = p.prof_id
             LEFT JOIN public.recursofisico r ON m.refi_id = r.refi_id
             WHERE e.estu_id = $1`,
            [req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// RUTAS PROTEGIDAS (SOLO DOCENTES AUTENTICADOS)
// ============================================================================

// NUEVO: Añadir Programa Académico
app.post('/api/programas', verificarDocente, async (req, res) => {
    const { prog_nombre } = req.body;
    try {
        const nuevo = await pool.query(
            'INSERT INTO public.programa (prog_nombre) VALUES ($1) RETURNING *',
            [prog_nombre.trim()]
        );
        res.json(nuevo.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// NUEVO: Modificar Programa Académico (actualiza también los estudiantes de ese programa)
app.put('/api/programas/:id', verificarDocente, async (req, res) => {
    const { id } = req.params;
    const { prog_nombre } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const anterior = await client.query('SELECT prog_nombre FROM public.programa WHERE prog_id = $1', [id]);
        if (anterior.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Programa no encontrado.' });
        }
        const nombreViejo = anterior.rows[0].prog_nombre;
        const actualizado = await client.query(
            'UPDATE public.programa SET prog_nombre = $1 WHERE prog_id = $2 RETURNING *',
            [prog_nombre.trim(), id]
        );
        await client.query(
            'UPDATE public.estudiante SET estu_programa = $1 WHERE estu_programa = $2',
            [prog_nombre.trim(), nombreViejo]
        );
        await client.query('COMMIT');
        res.json(actualizado.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Crear nuevo Salón / Recurso Físico
app.post('/api/recursos', verificarDocente, async (req, res) => {
    const { refi_descripcion, refi_capacidad } = req.body;
    try {
        const nuevo = await pool.query(
            'INSERT INTO public.recursofisico (refi_descripcion, refi_capacidad) VALUES ($1, $2) RETURNING *',
            [refi_descripcion, refi_capacidad]
        );
        res.json(nuevo.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Eliminar un Docente y reordenar los IDs consecutivamente (1, 2, 3...)
app.delete('/api/profesores/:id', verificarDocente, async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();

    try {
        const materiasAsignadas = await client.query(
            'SELECT mate_nombre FROM public.materia WHERE prof_id = $1',
            [id]
        );
        if (materiasAsignadas.rows.length > 0) {
            const lista = materiasAsignadas.rows.map(m => m.mate_nombre).join(', ');
            return res.status(400).json({
                error: `No se puede eliminar porque dicta: ${lista}. Reasigna primero esas materias a otro docente.`
            });
        }

        await client.query('BEGIN');

        const eliminado = await client.query(
            'DELETE FROM public.profesor WHERE prof_id = $1 RETURNING prof_id, prof_nombre',
            [id]
        );

        await client.query(`
            CREATE TEMP TABLE mapa_profesores AS
            SELECT prof_id AS viejo_id, ROW_NUMBER() OVER (ORDER BY prof_id ASC) AS nuevo_id
            FROM public.profesor;
        `);

        await client.query('UPDATE public.profesor SET prof_id = prof_id + 100000;');

        await client.query(`
            UPDATE public.materia m
            SET prof_id = mp.nuevo_id
            FROM mapa_profesores mp
            WHERE m.prof_id = mp.viejo_id;
        `);

        await client.query(`
            UPDATE public.profesor p
            SET prof_id = mp.nuevo_id
            FROM mapa_profesores mp
            WHERE p.prof_id = mp.viejo_id + 100000;
        `);

        await client.query(`
            SELECT setval(
                pg_get_serial_sequence('public.profesor', 'prof_id'),
                COALESCE((SELECT MAX(prof_id) FROM public.profesor), 0) + 1,
                false
            );
        `);

        await client.query('DROP TABLE mapa_profesores;');
        await client.query('COMMIT');

        res.json(eliminado.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Crear nueva Materia
app.post('/api/materias', verificarDocente, async (req, res) => {
    const { mate_nombre, mate_codigo, refi_id, prof_id } = req.body;
    try {
        const nueva = await pool.query(
            'INSERT INTO public.materia (mate_nombre, mate_codigo, refi_id, prof_id) VALUES ($1, $2, $3, $4) RETURNING *',
            [mate_nombre, mate_codigo, refi_id, prof_id]
        );
        res.json(nueva.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Editar una Materia (cambiar docente asignado o salón asignado)
app.put('/api/materias/:id', verificarDocente, async (req, res) => {
    const { id } = req.params;
    const { prof_id, refi_id } = req.body;
    try {
        const actualizada = await pool.query(
            'UPDATE public.materia SET prof_id = $1, refi_id = $2 WHERE mate_id = $3 RETURNING *',
            [prof_id, refi_id, id]
        );
        res.json(actualizada.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Crear nuevo Estudiante con su nota inicial y clave por defecto 1234
app.post('/api/estudiantes', verificarDocente, async (req, res) => {
    const { estu_documento, estu_nombre, estu_correo, mate_id, estu_nota, estu_programa, estu_password } = req.body;
    try {
        const correoFinal = estu_correo && estu_correo.trim() !== '' ? estu_correo : null;
        const claveFinal = estu_password && estu_password.trim() !== '' ? estu_password.trim() : '1234';
        const nuevo = await pool.query(
            `INSERT INTO public.estudiante (estu_documento, estu_nombre, estu_correo, mate_id, estu_nota, estu_programa, fecha_matricula, estu_password) 
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, $7) RETURNING *`,
            [estu_documento, estu_nombre, correoFinal, mate_id, estu_nota, estu_programa, claveFinal]
        );
        res.json(nuevo.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Modificar la nota de un Estudiante existente
app.put('/api/estudiantes/:id/nota', verificarDocente, async (req, res) => {
    const { id } = req.params;
    const { estu_nota } = req.body;
    try {
        const notaNum = parseFloat(estu_nota);
        if (isNaN(notaNum) || notaNum < 0 || notaNum > 5) {
            return res.status(400).json({ error: 'La nota debe estar entre 0.0 y 5.0' });
        }
        const actualizado = await pool.query(
            'UPDATE public.estudiante SET estu_nota = $1 WHERE estu_id = $2 RETURNING *',
            [notaNum, id]
        );
        res.json(actualizado.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});