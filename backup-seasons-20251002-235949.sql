--
-- PostgreSQL database dump
--

-- Dumped from database version 15.13
-- Dumped by pg_dump version 15.13

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: seasons; Type: TABLE; Schema: public; Owner: tennis_user
--

CREATE TABLE public.seasons (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    start_date date NOT NULL,
    end_date date,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    auto_end boolean DEFAULT false,
    description text,
    ended_at timestamp without time zone,
    ended_by character varying(100)
);


ALTER TABLE public.seasons OWNER TO tennis_user;

--
-- Name: COLUMN seasons.auto_end; Type: COMMENT; Schema: public; Owner: tennis_user
--

COMMENT ON COLUMN public.seasons.auto_end IS 'Whether season should automatically end on end_date';


--
-- Name: COLUMN seasons.description; Type: COMMENT; Schema: public; Owner: tennis_user
--

COMMENT ON COLUMN public.seasons.description IS 'Optional description of the season';


--
-- Name: COLUMN seasons.ended_at; Type: COMMENT; Schema: public; Owner: tennis_user
--

COMMENT ON COLUMN public.seasons.ended_at IS 'Timestamp when season was manually ended';


--
-- Name: COLUMN seasons.ended_by; Type: COMMENT; Schema: public; Owner: tennis_user
--

COMMENT ON COLUMN public.seasons.ended_by IS 'Username of admin/editor who ended the season';


--
-- Name: seasons_id_seq; Type: SEQUENCE; Schema: public; Owner: tennis_user
--

CREATE SEQUENCE public.seasons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.seasons_id_seq OWNER TO tennis_user;

--
-- Name: seasons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: tennis_user
--

ALTER SEQUENCE public.seasons_id_seq OWNED BY public.seasons.id;


--
-- Name: seasons id; Type: DEFAULT; Schema: public; Owner: tennis_user
--

ALTER TABLE ONLY public.seasons ALTER COLUMN id SET DEFAULT nextval('public.seasons_id_seq'::regclass);


--
-- Data for Name: seasons; Type: TABLE DATA; Schema: public; Owner: tennis_user
--

COPY public.seasons (id, name, start_date, end_date, is_active, created_at, auto_end, description, ended_at, ended_by) FROM stdin;
2	222	2025-09-09	\N	t	2025-09-30 16:22:20.752544	f	\N	\N	\N
3	1232	2025-10-15	2025-10-25	t	2025-10-02 16:48:03.064955	f		\N	\N
1	Wimbledon 2025	2025-06-29	2025-09-08	t	2025-09-30 16:21:10.737185	f	\N	\N	\N
\.


--
-- Name: seasons_id_seq; Type: SEQUENCE SET; Schema: public; Owner: tennis_user
--

SELECT pg_catalog.setval('public.seasons_id_seq', 3, true);


--
-- Name: seasons seasons_pkey; Type: CONSTRAINT; Schema: public; Owner: tennis_user
--

ALTER TABLE ONLY public.seasons
    ADD CONSTRAINT seasons_pkey PRIMARY KEY (id);


--
-- Name: idx_seasons_active; Type: INDEX; Schema: public; Owner: tennis_user
--

CREATE INDEX idx_seasons_active ON public.seasons USING btree (is_active);


--
-- PostgreSQL database dump complete
--

