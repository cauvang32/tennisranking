--
-- PostgreSQL database dump
--

\restrict DBaPUqVs4ehv2Nc7R18QbbtnH8hAumIZQQLpMviEsy5D8ilxy4QGeqwd7ZWWjFw

-- Dumped from database version 15.14
-- Dumped by pg_dump version 15.14

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
-- Name: seasons; Type: TABLE; Schema: public; Owner: hungsanity
--

CREATE TABLE public.seasons (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    start_date date NOT NULL,
    end_date date,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.seasons OWNER TO hungsanity;

--
-- Name: seasons_id_seq; Type: SEQUENCE; Schema: public; Owner: hungsanity
--

CREATE SEQUENCE public.seasons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.seasons_id_seq OWNER TO hungsanity;

--
-- Name: seasons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: hungsanity
--

ALTER SEQUENCE public.seasons_id_seq OWNED BY public.seasons.id;


--
-- Name: seasons id; Type: DEFAULT; Schema: public; Owner: hungsanity
--

ALTER TABLE ONLY public.seasons ALTER COLUMN id SET DEFAULT nextval('public.seasons_id_seq'::regclass);


--
-- Data for Name: seasons; Type: TABLE DATA; Schema: public; Owner: hungsanity
--

COPY public.seasons (id, name, start_date, end_date, is_active, created_at) FROM stdin;
1	Wimbledon 2025	2025-06-30	\N	t	2025-09-25 14:38:36.71257
\.


--
-- Name: seasons_id_seq; Type: SEQUENCE SET; Schema: public; Owner: hungsanity
--

SELECT pg_catalog.setval('public.seasons_id_seq', 1, true);


--
-- Name: seasons seasons_pkey; Type: CONSTRAINT; Schema: public; Owner: hungsanity
--

ALTER TABLE ONLY public.seasons
    ADD CONSTRAINT seasons_pkey PRIMARY KEY (id);


--
-- Name: idx_seasons_active; Type: INDEX; Schema: public; Owner: hungsanity
--

CREATE INDEX idx_seasons_active ON public.seasons USING btree (is_active);


--
-- PostgreSQL database dump complete
--

\unrestrict DBaPUqVs4ehv2Nc7R18QbbtnH8hAumIZQQLpMviEsy5D8ilxy4QGeqwd7ZWWjFw

