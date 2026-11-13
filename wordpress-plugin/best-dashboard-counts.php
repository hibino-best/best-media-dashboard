<?php
/**
 * Plugin Name: BEST Dashboard Counts
 * Description: BESTメディア数値ダッシュボード用。投稿の件数（公開・予約・レビュー待ち・下書き）だけを返します。記事のタイトル・本文・ユーザー情報は返しません。削除すれば元に戻ります。
 * Version: 1.0.0
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
add_action( 'rest_api_init', function () {
	register_rest_route( 'best-dashboard/v1', '/counts', array(
		'methods'             => 'GET',
		'permission_callback' => '__return_true',
		'callback'            => function () {
			$c = wp_count_posts( 'post' );
			return array(
				'publish' => (int) $c->publish,
				'future'  => (int) $c->future,
				'pending' => (int) $c->pending,
				'draft'   => (int) $c->draft,
			);
		},
	) );
} );
